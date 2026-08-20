import {
  tournamentEntryCoreScopes,
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../domain/mutation-scope';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  estimateTournamentSetupRequests,
  getTournamentBackfillWindow,
  isOfficialH2HTournament,
  type TournamentSetupPhase,
  type TournamentSetupStatus,
} from '../domain/tournament';
import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import { enqueueTournamentRepair } from '../jobs/tournament-repair.jobs';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { NotFoundError } from '../utils/errors';
import { getFplRequestMetricsSnapshot } from '../utils/fpl-request-metrics';
import { getJobLogContext } from '../utils/job-log-context';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import { auditTournamentSetup } from './tournament-audit.service';
import {
  calculateTournamentHistoryFromStoredResults,
  enrichTournamentHistory,
  ensureTournamentCoreResults,
  syncTournamentEntryDetails,
  normalizeTournamentSetupIssue,
  tournamentSetupIssueFromAuditMessage,
  type TournamentCoreSyncPlan,
  type TournamentEnrichmentPlan,
  type TournamentEntrySyncPlan,
  type TournamentSetupIssue,
} from './tournament-backfill.service';
import { refreshTournamentMaterializedViews } from './tournament-materialized-views.service';
import { rebuildTournamentStructure } from './tournament-structure.service';
import { syncOfficialH2HTournament } from './tournament-official-h2h.service';

export { ensureKnockoutRoundOneSeeded } from './tournament-seed.service';

function isBlockingCoreAuditIssue(issue: string): boolean {
  // League metadata enriches profiles but is not part of the scoring barrier.
  return !issue.startsWith('missing entry_league_infos');
}

type TournamentSetupAttemptOutcome =
  | 'ready'
  | 'ready_with_warnings'
  | 'failed_before_standings'
  | 'deleted_noop';

const EMPTY_ENTRY_PLAN: TournamentEntrySyncPlan = {
  totalEntries: 0,
  requestedEntries: 0,
  reusedEntries: 0,
};

const EMPTY_CORE_PLAN: TournamentCoreSyncPlan = {
  totalPairs: 0,
  missingPairs: 0,
  reusedPairs: 0,
};

const EMPTY_ENRICHMENT_PLAN: TournamentEnrichmentPlan = {
  totalPickPairs: 0,
  missingPickPairs: 0,
  reusedPickPairs: 0,
  totalTransferEntries: 0,
  requestedTransferEntries: 0,
  reusedTransferEntries: 0,
};

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

function elapsedBetween(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isNaN(startMs) || Number.isNaN(endMs) ? null : Math.max(0, endMs - startMs);
}

export async function finalizePublishedTournamentSetup(
  season: FplSeasonRef,
  tournamentId: number,
  warningMessageOrCount: string | null | number = null,
  warningCount = typeof warningMessageOrCount === 'number' ? warningMessageOrCount : 0,
): Promise<void> {
  // Resume first. If that transition fails, the setup remains processing and
  // the worker/watchdog can retry instead of leaving an inactive tournament
  // terminally marked ready.
  await tournamentRosterRepository.markReadyAndResume(season, tournamentId);
  await tournamentInfoRepository.markSetupResult(season, tournamentId, 'ready', null, warningCount);
}

export async function setupTournamentStructure(
  season: FplSeasonRef,
  tournamentId: number,
  options?: { resumeMarker?: string },
): Promise<void> {
  const setupStartedAtMs = performance.now();
  const phaseDurationsMs = {
    syncing_entries: 0,
    building_structure: 0,
    calculating_standings: 0,
    enriching_history: 0,
    finalizing: 0,
  };
  let entryPlan = { ...EMPTY_ENTRY_PLAN };
  let corePlan = { ...EMPTY_CORE_PLAN };
  let enrichmentPlan = { ...EMPTY_ENRICHMENT_PLAN };
  let entryCount = 0;
  let eventCount = 0;
  let setupEntryIds: number[] = [];
  let outcome: TournamentSetupAttemptOutcome = 'failed_before_standings';
  let failureCode: string | null = null;
  logInfo('Starting tournament setup', { tournamentId });
  let initialStatus: Awaited<ReturnType<typeof tournamentInfoRepository.findSetupStatus>>;
  let tournament: Awaited<ReturnType<typeof tournamentInfoRepository.findSetupConfig>>;
  try {
    [initialStatus, tournament] = await Promise.all([
      tournamentInfoRepository.findSetupStatus(season, tournamentId),
      tournamentInfoRepository.findSetupConfig(season, tournamentId),
    ]);
  } catch (error) {
    const context = getJobLogContext();
    failureCode = safeErrorCode(error);
    logInfo('Tournament setup attempt report', {
      event: 'tournament_setup_attempt',
      outcome,
      tournamentId,
      source: context?.source ?? 'unknown',
      attempt: context?.attempt ?? null,
      queueWaitMs: context?.queueWaitMs ?? null,
      setupAttemptDurationMs: Math.round(performance.now() - setupStartedAtMs),
      phaseDurationsMs,
      creationToStandingsMs: null,
      enrichmentDurationMs: null,
      creationToReadyMs: null,
      entryCount,
      eventCount,
      standingsPublished: false,
      warningCount: 0,
      failureCode,
      work: { entrySnapshots: entryPlan, coreResults: corePlan, enrichment: enrichmentPlan },
      fpl: getFplRequestMetricsSnapshot(),
    });
    throw error;
  }
  if (!tournament || !initialStatus) {
    logInfo('Tournament disappeared before setup started; treating job as complete', {
      tournamentId,
    });
    const context = getJobLogContext();
    logInfo('Tournament setup attempt report', {
      event: 'tournament_setup_attempt',
      outcome: 'deleted_noop' satisfies TournamentSetupAttemptOutcome,
      tournamentId,
      source: context?.source ?? 'unknown',
      attempt: context?.attempt ?? null,
      queueWaitMs: context?.queueWaitMs ?? null,
      setupAttemptDurationMs: Math.round(performance.now() - setupStartedAtMs),
      phaseDurationsMs,
      creationToStandingsMs: null,
      enrichmentDurationMs: null,
      creationToReadyMs: null,
      entryCount: 0,
      eventCount: 0,
      standingsPublished: false,
      warningCount: 0,
      failureCode: null,
      work: { entrySnapshots: entryPlan, coreResults: corePlan, enrichment: enrichmentPlan },
      fpl: getFplRequestMetricsSnapshot(),
    });
    return;
  }

  // Historical readiness must not downgrade a failure in this new setup or
  // resume attempt into a warning. Only publication completed below makes
  // failures non-critical for this attempt.
  let standingsPublished = false;
  const progressMarker = options?.resumeMarker;
  const markSetupProgress = (
    phase: TournamentSetupPhase,
    completedUnits: number,
    totalUnits: number,
    progressIndeterminate = false,
  ) =>
    tournamentInfoRepository.markSetupProgress(
      season,
      tournamentId,
      phase,
      completedUnits,
      totalUnits,
      progressMarker,
      progressIndeterminate,
    );

  try {
    await tournamentInfoRepository.markSetupProcessing(season, tournamentId, progressMarker);
    const setupIssues: TournamentSetupIssue[] = [];
    const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
      season,
      tournamentId,
    );
    setupEntryIds = entryIds;
    entryCount = entryIds.length;
    const finalizedEvent = await eventRepository.findLatestFinalized(season);
    const window = getTournamentBackfillWindow(tournament, finalizedEvent?.id ?? null);
    eventCount = window ? window.endEventId - window.startEventId + 1 : 0;
    const targetEventId = window?.endEventId ?? 0;
    let phaseStartedAtMs = performance.now();

    // Entry FPL sync: entry-core only — do NOT hold tournament-structure:global
    // across potentially long external HTTP (FP-07 Codex P1).
    const entrySyncIssues = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        scopes: tournamentEntryCoreScopes(season.seasonId, entryIds),
      },
      () =>
        syncTournamentEntryDetails(season, entryIds, {
          targetEventId,
          onPlan: async (plan) => {
            entryPlan = plan;
            await markSetupProgress('syncing_entries', 0, plan.requestedEntries);
          },
          onProgress: (completed, total) => markSetupProgress('syncing_entries', completed, total),
        }),
    );
    setupIssues.push(...entrySyncIssues);
    phaseDurationsMs.syncing_entries = Math.round(performance.now() - phaseStartedAtMs);
    logInfo('Tournament setup phase completed', {
      tournamentId,
      phase: 'syncing_entries',
      durationMs: phaseDurationsMs.syncing_entries,
      entryCount: entryIds.length,
      requestedEntries: entryPlan.requestedEntries,
      reusedEntries: entryPlan.reusedEntries,
      warningCount: setupIssues.length,
    });
    const blockingEntryIssues = entrySyncIssues.filter((issue) => issue.blocksStandings);
    if (blockingEntryIssues.length > 0) {
      throw new Error(
        `Entry snapshot preparation failed: ${blockingEntryIssues
          .map((issue) => issue.message)
          .join('; ')}`,
      );
    }

    phaseStartedAtMs = performance.now();
    await markSetupProgress('building_structure', 0, 1);
    const entrySeeds = await tournamentEntryRepository.findEntrySeedsByTournamentId(
      season,
      tournamentId,
    );

    // Structure rebuild: per-tournament + global (C4 mutual exclusion with results).
    await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        scopes: tournamentSetupRebuildScopes(tournamentId),
      },
      () => rebuildTournamentStructure(season, tournament, entrySeeds),
    );
    await markSetupProgress('building_structure', 1, 1);
    phaseDurationsMs.building_structure = Math.round(performance.now() - phaseStartedAtMs);
    logInfo('Tournament setup phase completed', {
      tournamentId,
      phase: 'building_structure',
      durationMs: phaseDurationsMs.building_structure,
      entryCount: entrySeeds.length,
    });

    if (isOfficialH2HTournament(tournament)) {
      await syncOfficialH2HTournament(season, tournament);
    }

    phaseStartedAtMs = performance.now();
    logInfo('Tournament setup request budget', {
      tournamentId,
      entryCount: entryIds.length,
      eventCount,
      ...estimateTournamentSetupRequests(entryIds.length, eventCount),
    });
    await markSetupProgress('calculating_standings', 0, 0);
    if (window) {
      await ensureTournamentCoreResults(
        season,
        entryIds,
        window,
        (completed) =>
          markSetupProgress('calculating_standings', completed, corePlan.missingPairs + eventCount),
        async (plan) => {
          corePlan = plan;
          await markSetupProgress('calculating_standings', 0, plan.missingPairs + eventCount);
        },
        {
          requirePicksForEvents:
            !isOfficialH2HTournament(tournament) &&
            tournament.knockoutMode !== 'no_knockout' &&
            tournament.knockoutStartedEventId &&
            tournament.knockoutEndedEventId
              ? Array.from(
                  {
                    length: Math.max(
                      0,
                      Math.min(window.endEventId, tournament.knockoutEndedEventId) -
                        Math.max(window.startEventId, tournament.knockoutStartedEventId) +
                        1,
                    ),
                  },
                  (_, index) =>
                    Math.max(window.startEventId, tournament.knockoutStartedEventId!) + index,
                )
              : [],
        },
      );
    }
    await calculateTournamentHistoryFromStoredResults(
      season,
      tournamentId,
      tournament,
      window,
      (completed) =>
        markSetupProgress(
          'calculating_standings',
          corePlan.missingPairs + completed,
          corePlan.missingPairs + eventCount,
        ),
    );
    const coreAudit = await auditTournamentSetup(season, tournament, window);
    const blockingCoreIssues = coreAudit.issues.filter(isBlockingCoreAuditIssue);
    if (blockingCoreIssues.length > 0) {
      throw new Error(`Core tournament audit failed: ${blockingCoreIssues.join('; ')}`);
    }
    await tournamentInfoRepository.markStandingsReady(season, tournamentId, progressMarker);
    standingsPublished = true;
    phaseDurationsMs.calculating_standings = Math.round(performance.now() - phaseStartedAtMs);
    logInfo('Tournament setup phase completed', {
      tournamentId,
      phase: 'calculating_standings',
      durationMs: phaseDurationsMs.calculating_standings,
      eventCount,
      standingsPublished: true,
    });

    phaseStartedAtMs = performance.now();
    await markSetupProgress('enriching_history', 0, 0, true);
    setupIssues.push(
      ...(await enrichTournamentHistory(season, tournamentId, entryIds, window, {
        onPlan: (plan) => {
          enrichmentPlan = plan;
        },
        onProgress: (completed, total) => markSetupProgress('enriching_history', completed, total),
      })),
    );
    phaseDurationsMs.enriching_history = Math.round(performance.now() - phaseStartedAtMs);
    logInfo('Tournament setup phase completed', {
      tournamentId,
      phase: 'enriching_history',
      durationMs: phaseDurationsMs.enriching_history,
      warningCount: setupIssues.length,
    });

    phaseStartedAtMs = performance.now();
    await markSetupProgress('finalizing', 0, 1);
    const audit = await auditTournamentSetup(season, tournament, window);
    await refreshTournamentMaterializedViews();
    await markSetupProgress('finalizing', 1, 1);
    phaseDurationsMs.finalizing = Math.round(performance.now() - phaseStartedAtMs);
    logInfo('Tournament setup phase completed', {
      tournamentId,
      phase: 'finalizing',
      durationMs: phaseDurationsMs.finalizing,
      warningCount: setupIssues.length,
    });

    const auditIssues = audit.issues.map((message) =>
      tournamentSetupIssueFromAuditMessage(message, {
        affectedEntryIds: message.startsWith('missing entry_league_infos')
          ? audit.missingEntryLeagueInfoIds
          : message.startsWith('missing entry_infos')
            ? audit.missingEntryInfoIds
            : entryIds,
      }),
    );
    setupIssues.push(...auditIssues);
    const persistedIssues = setupIssues.map(normalizeTournamentSetupIssue);
    const issueState = await tournamentSetupIssueRepository.sync(
      season,
      tournamentId,
      persistedIssues,
    );
    const unresolvedIssues = await tournamentSetupIssueRepository.listUnresolved(
      season,
      tournamentId,
    );
    await Promise.all(unresolvedIssues.map((issue) => enqueueTournamentRepair(season, issue)));
    await finalizePublishedTournamentSetup(season, tournamentId, issueState.warningCount);
    outcome = setupIssues.length > 0 ? 'ready_with_warnings' : 'ready';
    logInfo('Tournament setup completed', {
      tournamentId,
      backfillStartEventId: window?.startEventId ?? null,
      backfillEndEventId: window?.endEventId ?? null,
      warnings: setupIssues.length,
      warningCount: issueState.warningCount,
      durationMs: Math.round(performance.now() - setupStartedAtMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tournament setup failed.';
    failureCode = safeErrorCode(error);
    logError('Tournament setup failed', error, {
      tournamentId,
      durationMs: Math.round(performance.now() - setupStartedAtMs),
      standingsPublished,
    });
    if (standingsPublished) {
      const issueState = await tournamentSetupIssueRepository.sync(season, tournamentId, [
        normalizeTournamentSetupIssue({
          scope: 'event-results',
          message,
          failedEntries: setupEntryIds,
          diagnosticCode: failureCode,
        }),
      ]);
      await finalizePublishedTournamentSetup(season, tournamentId, issueState.warningCount);
      outcome = 'ready_with_warnings';
      return;
    }
    outcome = 'failed_before_standings';
    // BullMQ owns retry classification. Keep the row PROCESSING until the
    // worker observes whether this attempt is retryable or terminal; this
    // prevents a transient lock/FPL failure from rendering a false FAILED UI.
    throw error;
  } finally {
    let terminalStatus = null;
    try {
      terminalStatus = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
    } catch (error) {
      logError('Unable to read terminal tournament setup status for reporting', error, {
        tournamentId,
      });
    }
    const context = getJobLogContext();
    const createdAt = terminalStatus?.createdAt ?? initialStatus.createdAt;
    const standingsReadyAt = terminalStatus?.standingsReadyAt ?? initialStatus.standingsReadyAt;
    const setupFinishedAt = terminalStatus?.setupFinishedAt ?? null;
    const ready = terminalStatus?.setupStatus === 'ready';
    logInfo('Tournament setup attempt report', {
      event: 'tournament_setup_attempt',
      outcome,
      tournamentId,
      source: context?.source ?? 'unknown',
      attempt: context?.attempt ?? null,
      queueWaitMs: context?.queueWaitMs ?? null,
      setupAttemptDurationMs: Math.round(performance.now() - setupStartedAtMs),
      phaseDurationsMs,
      creationToStandingsMs: elapsedBetween(createdAt, standingsReadyAt),
      enrichmentDurationMs: ready ? elapsedBetween(standingsReadyAt, setupFinishedAt) : null,
      creationToReadyMs: ready ? elapsedBetween(createdAt, setupFinishedAt) : null,
      entryCount,
      eventCount,
      standingsPublished,
      warningCount: terminalStatus?.setupWarningCount ?? 0,
      failureCode,
      work: { entrySnapshots: entryPlan, coreResults: corePlan, enrichment: enrichmentPlan },
      fpl: getFplRequestMetricsSnapshot(),
    });
  }
}

export async function requeueTournamentSetup(season: FplSeasonRef, tournamentId: number) {
  const tournament = await tournamentInfoRepository.findSetupConfig(season, tournamentId);
  if (!tournament) {
    throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
  }

  let retryStatePrepared = false;
  try {
    return await enqueueTournamentSetup(season, tournamentId, 'manual', {
      forceNew: true,
      prepareEnqueue: async () => {
        await tournamentInfoRepository.markSetupRetryQueued(season, tournamentId);
        retryStatePrepared = true;
      },
    });
  } catch (error) {
    if (!retryStatePrepared) throw error;
    const message = error instanceof Error ? error.message : 'Unable to enqueue setup retry.';
    await tournamentInfoRepository.markSetupResult(season, tournamentId, 'failed', message, 0);
    throw error;
  }
}

export async function recoverStuckTournamentSetups(
  season: FplSeasonRef,
  cutoffMinutes: number,
  isActive?: (tournamentId: number) => Promise<boolean>,
  recoverOfficialRoster?: (
    season: FplSeasonRef,
    tournamentId: number,
    resumeMarker: string,
    setupStatus: TournamentSetupStatus,
    setupPhase: TournamentSetupPhase,
    rosterLastSyncedAt: string | null,
  ) => Promise<void>,
): Promise<{ recovered: number[]; skippedActive: number[] }> {
  const stuck = await tournamentInfoRepository.findStuckProcessing(season, cutoffMinutes);
  if (stuck.length === 0) {
    return { recovered: [], skippedActive: [] };
  }

  const recovered: number[] = [];
  const skippedActive: number[] = [];
  for (const row of stuck) {
    try {
      await withMutationConflictGuard(
        {
          queueName: 'tournament-setup-watchdog',
          jobName: 'recover-stuck-setup',
          tournamentId: row.id,
          scopes: [tournamentSetupLifecycleScope(row.id)],
        },
        async () => {
          // The queue probe above is only a candidate. Recheck while holding
          // the same lifecycle lock as roster/setup workers so a retry queued
          // after the first probe cannot be invalidated by this watchdog.
          if (isActive && (await isActive(row.id))) {
            skippedActive.push(row.id);
            logInfo('Skipping watchdog recovery after a live job appeared', {
              tournamentId: row.id,
              setupProgressUpdatedAt: row.setupProgressUpdatedAt,
            });
            return;
          }

          // An inactive official-sync row with a pending/processing setup is
          // resume-owned. Replaying setup directly would rebuild from the old
          // roster and could activate the tournament without authoritative
          // roster publication. Replay the marker-pinned roster operation
          // first; the marked setup job will be enqueued by that operation.
          if (
            row.state === 'inactive' &&
            row.rosterMode === 'official_sync' &&
            (row.rosterSyncStatus === 'processing' || row.rosterSyncStatus === 'failed')
          ) {
            if (!recoverOfficialRoster || !row.setupProgressUpdatedAt) {
              logInfo('Skipping watchdog recovery without an official resume marker', {
                tournamentId: row.id,
                setupProgressUpdatedAt: row.setupProgressUpdatedAt,
              });
              return;
            }
            await recoverOfficialRoster(
              season,
              row.id,
              row.setupProgressUpdatedAt,
              row.setupStatus,
              row.setupPhase,
              row.rosterLastSyncedAt,
            );
            recovered.push(row.id);
            logInfo('Watchdog replayed stalled official roster resume', {
              tournamentId: row.id,
              setupProgressUpdatedAt: row.setupProgressUpdatedAt,
            });
            return;
          }

          // The initial stale query and BullMQ probe are only candidates. A
          // worker may publish readiness or advance its heartbeat before this
          // lock is acquired, so compare-and-swap the exact observed heartbeat
          // before changing canonical state.
          const marked = await tournamentInfoRepository.markStuckSetupQueuedIfUnchanged(
            season,
            row.id,
            row.setupProgressUpdatedAt,
          );
          if (!marked) {
            logInfo('Skipping watchdog recovery after setup state advanced', {
              tournamentId: row.id,
              observedSetupProgressUpdatedAt: row.setupProgressUpdatedAt,
            });
            return;
          }
          await enqueueTournamentSetup(season, row.id, 'watchdog', {
            forceNew: true,
            activeSettleTimeoutMs: 2_000,
          });
          recovered.push(row.id);
          logInfo('Watchdog recovered stuck tournament setup', {
            tournamentId: row.id,
            setupProgressUpdatedAt: row.setupProgressUpdatedAt,
          });
        },
      );
    } catch (error) {
      logError('Watchdog failed to recover stuck tournament setup', error, {
        tournamentId: row.id,
      });
    }
  }

  return { recovered, skippedActive };
}
