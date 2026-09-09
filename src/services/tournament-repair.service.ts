import type { FplSeasonRef } from '../domain/fpl-season';
import {
  resolveMutationScopes,
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
import {
  tournamentSetupIssueRepository,
  type TournamentRepairState,
} from '../repositories/tournament-setup-issues';
import { withTournamentRepairPhase } from '../utils/tournament-repair-phase';
import { registerDatabasePostCommit } from '../db/singleton';
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

/** A setup issue row is reused across occurrences by its stable issue key.
 * Use the durable last-seen timestamp as the occurrence generation so a
 * resolved issue that reappears receives a new correction Change ID, while
 * retries of the same occurrence remain idempotent. */
function repairCorrectionChangeId(
  season: FplSeasonRef,
  issue: { issueId: number; lastSeenAt: Date },
): string {
  const seenAt =
    issue.lastSeenAt instanceof Date && Number.isFinite(issue.lastSeenAt.getTime())
      ? issue.lastSeenAt.toISOString().replace(/[^0-9]/g, '')
      : 'unknown-occurrence';
  return `tournament-repair-${season.seasonCode}-${issue.issueId}-${seenAt}`;
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

async function repairTournamentSetupIssuePrepared(
  season: FplSeasonRef,
  issueId: number,
  owner: TournamentRepairState,
  onStateCaptured?: (state: TournamentRepairState) => void,
): Promise<void> {
  const runPhase = <T>(scopes: readonly string[], operation: () => Promise<T>) =>
    withTournamentRepairPhase(season, issueId, owner, scopes, operation);
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
      const entryIssues = await syncTournamentEntryDetails(season, targetEntryIds, {
        targetEventId: window?.endEventId ?? 0,
        forceSnapshotRefresh: true,
      });
      repairIssues.push(...entryIssues);
      break;
    }

    case 'ENTRY_HISTORY_INCOMPLETE': {
      if (targetEntryIds.length === 0 || eventId === null) break;
      const transferResult = await syncEntryTransferHistories(season, targetEntryIds, eventId, {
        concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
        perEntryMutationScopes: true,
      });
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
            scopes: [
              ...resolveMutationScopes({
                queueName: 'tournament-sync',
                jobName: 'tournament-selection-stats',
                eventId,
              }),
              ...tournamentEntryCoreScopes(season.seasonId, allEntryIds),
            ],
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
      await runPhase(tournamentSetupRebuildScopes(issue.tournamentId), () =>
        rebuildTournamentStructure(season, tournament, entrySeeds),
      );
      // A topology rebuild can change group membership, phase boundaries, or
      // bracket edges for every settled event. Defer the correction reset
      // until the post-repair audit succeeds, then fence the earliest head
      // and enqueue every affected scope with durable provenance.
      reviewCorrection = {
        kind: 'tournament',
        reason: `Tournament structure repair issue ${issue.issueId}`,
        changeId: repairCorrectionChangeId(season, issue),
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
        { issueId, owner },
      );
      repairIssues.push(...resultIssues);
      if (resultIssues.length === 0) {
        reviewCorrection = {
          kind: 'event',
          eventId,
          reason: `Tournament results repair issue ${issue.issueId}`,
          changeId: repairCorrectionChangeId(season, issue),
        };
      }
      break;
    }
  }

  const remainingIssues = await runPhase([], async () => {
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
    const settledState = await tournamentSetupIssueRepository.lockRepairState(season, issueId);
    if (settledState)
      registerDatabasePostCommit(async () => {
        onStateCaptured?.(settledState);
      });
    registerDatabasePostCommit(async () => {
      await Promise.all(
        remainingIssues.map((remaining) =>
          enqueueTournamentRepair(season, remaining, 'reconciliation'),
        ),
      );
      if (correctionEventIds) {
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
    });
    return remainingIssues;
  });
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
}

export async function repairTournamentSetupIssue(
  season: FplSeasonRef,
  issueId: number,
  onStateCaptured?: (state: TournamentRepairState) => void,
): Promise<void> {
  const candidate = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  if (!candidate) return;

  const owner = await withMutationScopes(
    {
      queueName: 'tournament-repair',
      jobName: 'repair-issue',
      tournamentId: candidate.tournamentId,
      scopes: [tournamentSetupLifecycleScope(candidate.tournamentId)],
    },
    () => tournamentSetupIssueRepository.lockRepairState(season, issueId),
  );
  if (owner) {
    onStateCaptured?.(owner);
    await repairTournamentSetupIssuePrepared(season, issueId, owner, onStateCaptured);
  }
}
