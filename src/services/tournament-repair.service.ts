import type { FplSeasonRef } from '../domain/fpl-season';
import {
  tournamentEntryCoreScopes,
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../domain/mutation-scope';
import { getTournamentBackfillWindow } from '../domain/tournament';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../queues/entry-sync.queue';
import { enqueueTournamentRepair } from '../jobs/tournament-repair.jobs';
import { enqueueTournamentReview } from '../jobs/maintenance.jobs';
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
import {
  requestTournamentReviewCorrection,
  requestTournamentReviewTournamentCorrection,
} from './tournament-review-publication.service';
import { uniqueNumbers } from '../utils/async';
import { logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';

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
  let reviewCorrection:
    | { kind: 'event'; eventId: number; reason: string; changeId: string }
    | { kind: 'tournament'; reason: string; changeId: string }
    | null = null;

  switch (issue.code) {
    case 'ENTRY_PROFILE_INCOMPLETE': {
      if (targetEntryIds.length === 0) break;
      const entryIssues = await withMutationScopes(
        {
          queueName: 'tournament-repair',
          jobName: 'entry-profile',
          tournamentId: issue.tournamentId,
          scopes: tournamentEntryCoreScopes(season.seasonId, targetEntryIds),
        },
        () =>
          syncTournamentEntryDetails(season, targetEntryIds, {
            targetEventId: window?.endEventId ?? 0,
            forceSnapshotRefresh: true,
          }),
      );
      repairIssues.push(...entryIssues);
      break;
    }

    case 'ENTRY_HISTORY_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      const transferResult = await withMutationScopes(
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
        const result = await withMutationScopes(
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
      await withMutationScopes(
        {
          queueName: 'tournament-repair',
          jobName: 'structure',
          tournamentId: issue.tournamentId,
          scopes: tournamentSetupRebuildScopes(issue.tournamentId),
        },
        () => rebuildTournamentStructure(season, tournament, entrySeeds),
      );
      // A topology rebuild can change group membership, phase boundaries, or
      // bracket edges for every settled event. Defer the correction reset
      // until the post-repair audit succeeds, then fence the earliest head
      // and enqueue every affected scope with durable provenance.
      reviewCorrection = {
        kind: 'tournament',
        reason: `Tournament structure repair issue ${issue.issueId}`,
        changeId: `tournament-repair-${season.seasonCode}-${issue.issueId}`,
      };
      break;
    }

    case 'TOURNAMENT_RESULTS_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      const resultIssues = await runTournamentEventBackfill(
        season,
        issue.tournamentId,
        tournament,
        targetEntryIds,
        eventId,
      );
      repairIssues.push(...resultIssues);
      if (resultIssues.length === 0) {
        reviewCorrection = {
          kind: 'event',
          eventId,
          reason: `Tournament results repair issue ${issue.issueId}`,
          changeId: `tournament-repair-${season.seasonCode}-${issue.issueId}`,
        };
      }
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
  const existingUnresolved = await tournamentSetupIssueRepository.listUnresolved(
    season,
    issue.tournamentId,
  );

  // Do not resolve the setup issue before the correction fence is durable. If
  // the reset/enqueue fails after `sync` clears this row, the repair watchdog
  // would have no unresolved issue left to retry. The audit result is the
  // gate: only when this issue key is absent from the repaired set may we
  // fence immutable review heads first.
  let correctionEventIds: number[] | null = null;
  if (reviewCorrection && !persisted.some((candidate) => candidate.issueKey === issue.issueKey)) {
    correctionEventIds =
      reviewCorrection.kind === 'tournament'
        ? await requestTournamentReviewTournamentCorrection(
            season,
            issue.tournamentId,
            reviewCorrection.reason,
            reviewCorrection.changeId,
          )
        : await requestTournamentReviewCorrection(
            season,
            issue.tournamentId,
            reviewCorrection.eventId,
            reviewCorrection.reason,
            reviewCorrection.changeId,
            true,
          );
  }
  await tournamentSetupIssueRepository.sync(season, issue.tournamentId, persisted, {
    preserveUnresolvedIssueKeys: existingUnresolved
      .filter((existing) => existing.issueId !== issueId)
      .map((existing) => existing.issueKey),
  });
  const remainingIssues = await tournamentSetupIssueRepository.listUnresolved(
    season,
    issue.tournamentId,
  );
  await Promise.all(
    remainingIssues.map((remaining) =>
      enqueueTournamentRepair(season, remaining, 'reconciliation'),
    ),
  );
  logInfo('Tournament setup issue repair completed', {
    tournamentId: issue.tournamentId,
    issueId,
    repairedEntryCount: targetEntryIds.length,
    eventId,
    remainingIssues: remainingIssues.length,
  });
  if (remainingIssues.some((remaining) => remaining.issueId === issueId)) {
    // Keep the BullMQ attempt budget active for a still-open issue. Returning
    // successfully here would consume the deterministic job while the issue
    // only became eligible for the six-attempt/5-minute retry policy.
    throw new Error(`Tournament setup repair remains incomplete: ${issue.code}`);
  }

  if (correctionEventIds !== null) {
    if (correctionEventIds.length > 0) {
      await Promise.all(
        correctionEventIds.map((correctionEventId) =>
          enqueueTournamentReview(season, 'reconcile', {
            tournamentId: issue.tournamentId,
            eventId: correctionEventId,
            deduplicationId: `tournament-review-repair-${season.seasonCode}-${issue.tournamentId}-${correctionEventId}-${reviewCorrection?.changeId}`,
          }),
        ),
      );
    }

    // A topology/result repair is never allowed to fall through to routine
    // reconciliation: that path deliberately skips READY obligations and
    // would leave a frozen head on the pre-repair facts. An empty result is
    // valid only when the tournament has not created a review obligation yet.
    // In that case the normal eligibility discovery will create its initial
    // publication; there is no READY head to invalidate.
    return;
  }
}

export async function repairTournamentSetupIssue(
  season: FplSeasonRef,
  issueId: number,
): Promise<void> {
  const candidate = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  if (!candidate) return;

  await withMutationScopes(
    {
      queueName: 'tournament-repair',
      jobName: 'repair-issue',
      tournamentId: candidate.tournamentId,
      scopes: [tournamentSetupLifecycleScope(candidate.tournamentId)],
    },
    () => repairTournamentSetupIssueUnlocked(season, issueId),
  );
}
