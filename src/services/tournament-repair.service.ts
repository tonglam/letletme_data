import type { FplSeasonRef } from '../domain/fpl-season';
import {
  tournamentEntryCoreScopes,
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../domain/mutation-scope';
import { getTournamentBackfillWindow } from '../domain/tournament';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../queues/entry-sync.queue';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { syncEntryTransferHistories } from './tournament-event-results.service';
import {
  normalizeTournamentSetupIssue,
  runTournamentEventBackfill,
  syncTournamentEntryDetails,
  tournamentSetupIssueFromAuditMessage,
  type TournamentSetupIssue,
} from './tournament-backfill.service';
import { auditTournamentSetup } from './tournament-audit.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';
import { syncTournamentSelectionStats } from './tournament-selection-stats.service';
import { rebuildTournamentStructure } from './tournament-structure.service';
import { uniqueNumbers } from '../utils/async';
import { logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

function scopedEntryIds(allEntryIds: number[], affectedEntryIds: number[]): number[] {
  const allowed = new Set(allEntryIds);
  const requested = uniqueNumbers(affectedEntryIds).filter((entryId) => allowed.has(entryId));
  return requested.length > 0 ? requested : allEntryIds;
}

function issueEventId(
  issueEventIdValue: number | null,
  window: { startEventId: number; endEventId: number } | null,
): number | null {
  if (
    issueEventIdValue !== null &&
    issueEventIdValue !== undefined &&
    Number.isInteger(issueEventIdValue) &&
    issueEventIdValue > 0
  ) {
    return issueEventIdValue;
  }
  return window?.endEventId ?? null;
}

function dedupeIssues(issues: TournamentSetupIssue[]) {
  const byKey = new Map<string, ReturnType<typeof normalizeTournamentSetupIssue>>();
  for (const issue of issues) {
    const normalized = normalizeTournamentSetupIssue(issue);
    byKey.set(normalized.issueKey, normalized);
  }
  return [...byKey.values()];
}

async function repairTournamentSetupIssueUnlocked(
  season: FplSeasonRef,
  issueId: number,
): Promise<void> {
  const issue = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  if (!issue) return;

  const tournament = await tournamentInfoRepository.findSetupConfig(season, issue.tournamentId);
  if (!tournament) return;

  const allEntryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
    season,
    issue.tournamentId,
  );
  const targetEntryIds = scopedEntryIds(allEntryIds, issue.affectedEntryIds ?? []);
  const finalizedEvent = await eventRepository.findLatestFinalized(season);
  const window = getTournamentBackfillWindow(tournament, finalizedEvent?.id ?? null);
  const eventId = issueEventId(issue.eventId ?? null, window);
  const repairIssues: TournamentSetupIssue[] = [];

  switch (issue.code) {
    case 'ENTRY_PROFILE_INCOMPLETE': {
      if (targetEntryIds.length === 0) break;
      const entryIssues = await withMutationConflictGuard(
        {
          queueName: 'tournament-repair',
          jobName: 'entry-profile',
          tournamentId: issue.tournamentId,
          scopes: tournamentEntryCoreScopes(season.seasonId, targetEntryIds),
        },
        () =>
          syncTournamentEntryDetails(season, targetEntryIds, {
            targetEventId: window?.endEventId ?? 0,
          }),
      );
      repairIssues.push(...entryIssues);
      break;
    }

    case 'ENTRY_HISTORY_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      const transferResult = await withMutationConflictGuard(
        {
          queueName: 'tournament-repair',
          jobName: 'entry-transfer-history',
          tournamentId: issue.tournamentId,
          eventId,
          scopes: tournamentEntryCoreScopes(season.seasonId, targetEntryIds),
        },
        () =>
          syncEntryTransferHistories(season, targetEntryIds, eventId, {
            concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
          }),
      );
      if (transferResult.errors > 0) {
        repairIssues.push({
          scope: 'event-results',
          code: 'ENTRY_HISTORY_INCOMPLETE',
          category: 'insights',
          message: `Failed to sync transfer history for ${transferResult.errors} entries`,
          failedEntries: transferResult.failedEntryIds,
        });
      }
      break;
    }

    case 'LEAGUE_INSIGHTS_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      try {
        const result = await syncLeagueEventResultsByTournament(
          season,
          issue.tournamentId,
          eventId,
          { concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY, entryIds: targetEntryIds },
        );
        if (result.failedUnits > 0 || result.skipped > 0) {
          repairIssues.push({
            scope: 'league-event-results',
            code: 'LEAGUE_INSIGHTS_INCOMPLETE',
            category: 'insights',
            eventId,
            message: `League insights incomplete for event ${eventId}: ${result.succeededUnits}/${result.totalEntries}`,
            failedEntries: targetEntryIds,
          });
        }
      } catch (error) {
        repairIssues.push({
          scope: 'league-event-results',
          code: 'LEAGUE_INSIGHTS_INCOMPLETE',
          category: 'insights',
          eventId,
          message: error instanceof Error ? error.message : 'League insights repair failed',
          failedEntries: targetEntryIds,
        });
      }
      break;
    }

    case 'SELECTION_INSIGHTS_INCOMPLETE': {
      if (eventId === null) break;
      try {
        const result = await withMutationConflictGuard(
          {
            queueName: 'tournament-repair',
            jobName: 'selection-insights',
            tournamentId: issue.tournamentId,
            eventId,
            scopes: tournamentEntryCoreScopes(season.seasonId, allEntryIds),
          },
          () =>
            syncTournamentSelectionStats(season, eventId, {
              tournamentIds: [issue.tournamentId],
            }),
        );
        if (result.failedUnits > 0 || (targetEntryIds.length > 0 && result.rows === 0)) {
          repairIssues.push({
            scope: 'selection-insights',
            code: 'SELECTION_INSIGHTS_INCOMPLETE',
            category: 'insights',
            eventId,
            message: `Selection insights are incomplete for event ${eventId}`,
            failedEntries: targetEntryIds,
          });
        }
      } catch (error) {
        repairIssues.push({
          scope: 'selection-insights',
          code: 'SELECTION_INSIGHTS_INCOMPLETE',
          category: 'insights',
          eventId,
          message: error instanceof Error ? error.message : 'Selection insights repair failed',
          failedEntries: targetEntryIds,
        });
      }
      break;
    }

    case 'STRUCTURE_INTEGRITY_FAILED': {
      const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(
        season,
        issue.tournamentId,
      );
      await withMutationConflictGuard(
        {
          queueName: 'tournament-repair',
          jobName: 'structure',
          tournamentId: issue.tournamentId,
          scopes: tournamentSetupRebuildScopes(issue.tournamentId),
        },
        () => rebuildTournamentStructure(season, tournament, entrySeeds),
      );
      break;
    }

    case 'TOURNAMENT_RESULTS_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      repairIssues.push(
        ...(await runTournamentEventBackfill(
          season,
          issue.tournamentId,
          tournament,
          targetEntryIds,
          eventId,
        )),
      );
      break;
    }
  }

  const verifiedAudit = await auditTournamentSetup(season, tournament, window);
  const auditIssues = verifiedAudit.issues.map((message) =>
    tournamentSetupIssueFromAuditMessage(message, {
      affectedEntryIds: message.startsWith('missing entry_league_infos')
        ? verifiedAudit.missingEntryLeagueInfoIds
        : message.startsWith('missing entry_infos')
          ? verifiedAudit.missingEntryInfoIds
          : allEntryIds,
    }),
  );
  const persisted = dedupeIssues([...repairIssues, ...auditIssues]);
  await tournamentSetupIssueRepository.sync(season, issue.tournamentId, persisted);
  logInfo('Tournament setup issue repair completed', {
    tournamentId: issue.tournamentId,
    issueId,
    repairedEntryCount: targetEntryIds.length,
    eventId,
    remainingIssues: persisted.length,
  });
  if (persisted.length > 0) {
    // Keep the BullMQ attempt budget active for a still-open issue. Returning
    // successfully here would consume the deterministic job while the issue
    // only became eligible for the six-attempt/5-minute retry policy.
    throw new Error(`Tournament setup repair remains incomplete: ${issue.code}`);
  }
}

export async function repairTournamentSetupIssue(
  season: FplSeasonRef,
  issueId: number,
): Promise<void> {
  const candidate = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  if (!candidate) return;

  await withMutationConflictGuard(
    {
      queueName: 'tournament-repair',
      jobName: 'repair-issue',
      tournamentId: candidate.tournamentId,
      scopes: [tournamentSetupLifecycleScope(candidate.tournamentId)],
    },
    () => repairTournamentSetupIssueUnlocked(season, issueId),
  );
}
