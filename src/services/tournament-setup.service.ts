import {
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../domain/mutation-scope';
import { registerDatabasePostCommit } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  estimateTournamentSetupRequests,
  getTournamentBackfillWindow,
  isOfficialH2HTournament,
  type TournamentSetupPhase,
  type TournamentSetupStatus,
} from '../domain/tournament';
import { enqueueTournamentSetup, findTournamentSetupJob } from '../jobs/tournament-setup.jobs';
import { enqueueTournamentRepair } from '../jobs/tournament-repair.jobs';
import { enqueueTournamentReview } from '../jobs/maintenance.jobs';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentSetupExecution,
} from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { tournamentSetupIssueRepository } from '../repositories/tournament-setup-issues';
import { ConflictError, NotFoundError } from '../utils/errors';
import { getFplRequestMetricsSnapshot } from '../utils/fpl-request-metrics';
import { getJobLogContext } from '../utils/job-log-context';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { withTournamentSetupPhase } from '../utils/tournament-setup-execution';
import { runCompatibilitySchedulerPass } from '../scheduler/scheduler.service';
import {
  reserveSchedulerObligation,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';

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

function findErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let fallback: string | null = null;
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      fallback ??= current.code;
      if (/^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return fallback;
}

function safeErrorCode(error: unknown): string {
  return findErrorCode(error) ?? (error instanceof Error ? error.name : 'UNKNOWN_ERROR');
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
  // A custom tournament must enter the settled-review pipeline immediately
  // after setup becomes READY. The targeted worker reconciles all eligible
  // historical events for this tournament in one bounded batch; the global
  // five-minute scan remains the durable safety net.
  registerDatabasePostCommit(async () => {
    try {
      await enqueueTournamentReview(season, 'api', {
        tournamentId,
        attempts: 3,
        backoffDelayMs: 60_000,
        deduplicationId: `tournament-review-bootstrap-${season.seasonCode}-${tournamentId}`,
      });
    } catch (error) {
      logError('Failed to enqueue targeted tournament review bootstrap', error, {
        tournamentId,
        season: season.seasonCode,
      });
    }
  });
}

export async function setupTournamentStructure(
  season: FplSeasonRef,
  tournamentId: number,
  options?: {
    resumeMarker?: string;
    /** Stable marker owned by a non-resume setup handoff. */
    progressMarker?: string;
    execution?: TournamentSetupExecution;
  },
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

  // A successor or delayed BullMQ delivery may acquire the lifecycle lock
  // after another job has already published readiness. Never let that stale
  // delivery reset a READY tournament back to PROCESSING.
  if (initialStatus.setupStatus === 'ready') {
    outcome = initialStatus.setupWarningCount > 0 ? 'ready_with_warnings' : 'ready';
    logInfo('Ignoring tournament setup job after readiness was published', {
      tournamentId,
    });
    return;
  }

  // Historical readiness must not downgrade a failure in this new setup or
  // resume attempt into a warning. Only publication completed below makes
  // failures non-critical for this attempt.
  let standingsPublished = false;
  const progressMarker = options?.progressMarker ?? options?.resumeMarker;
  let execution: TournamentSetupExecution;
  const runPhase = <T>(phase: string, scopes: readonly string[], operation: () => Promise<T>) =>
    withTournamentSetupPhase(season, tournamentId, execution, phase, scopes, operation);
  const markSetupProgress = (
    phase: TournamentSetupPhase,
    completedUnits: number,
    totalUnits: number,
    progressIndeterminate = false,
  ) =>
    runPhase(phase, [], () =>
      tournamentInfoRepository.markSetupProgress(
        season,
        tournamentId,
        phase,
        completedUnits,
        totalUnits,
        progressMarker,
        progressIndeterminate,
      ),
    );

  let targetEventId = 0;
  const reserveRefresh = async () => {
    const materializedViewsRefreshObligation: SchedulerObligation =
      await reserveSchedulerObligation({
        definition: {
          name: 'tournament-materialized-views-refresh',
          cadence: 'after tournament setup commit or cascade barrier',
          timezone: 'UTC',
          queueName: 'tournament-sync',
        },
        plan: {
          scopeKey: `${season.seasonCode}:tournament:${tournamentId}`,
          periodKey: `setup-${tournamentId}-${targetEventId}-${execution.attempt}-${execution.startedAt}`,
          dueAt: new Date(),
          source: 'reconcile',
          eventId: targetEventId,
          evidence: { tournamentId, setupRefresh: true },
        },
      });
    registerDatabasePostCommit(async () => {
      // The durable row is the source of truth. This pass only attempts
      // delivery after commit; a failed pass leaves the row pending for the
      // next scheduler tick and therefore remains retryable.
      const delivery = await runCompatibilitySchedulerPass();
      logInfo('Requested scheduler delivery for tournament materialized-view refresh', {
        tournamentId,
        eventId: targetEventId,
        obligationId: materializedViewsRefreshObligation.obligationId,
        delivery,
      });
    });
  };

  try {
    if (!options?.execution) throw new Error('Tournament setup requires a claimed execution');
    execution = options.execution;
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
    targetEventId = window?.endEventId ?? 0;
    let phaseStartedAtMs = performance.now();

    // Entry provider reads run outside the per-entry canonical persistence scope.
    const entrySyncIssues = await syncTournamentEntryDetails(season, entryIds, {
      targetEventId,
      onPlan: async (plan) => {
        entryPlan = plan;
        await markSetupProgress('syncing_entries', 0, plan.requestedEntries);
      },
      onProgress: (completed, total) => markSetupProgress('syncing_entries', completed, total),
    });
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
    await runPhase('building_structure', tournamentSetupRebuildScopes(tournamentId), () =>
      rebuildTournamentStructure(season, tournament, entrySeeds),
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
      // Setup may import a completed official schedule before the regular
      // event-sync path runs. Reuse the latest finished + data-checked event
      // as an event-aware guard so sparse completed match rows retain their
      // score fallback without allowing live points to become results.
      await syncOfficialH2HTournament(season, tournament, undefined, {
        finalizedThroughEventId: finalizedEvent?.id ?? null,
        setupExecution: execution,
      });
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
      execution,
    );
    const coreAudit = await auditTournamentSetup(season, tournament, window);
    const blockingCoreIssues = coreAudit.issues.filter(isBlockingCoreAuditIssue);
    if (blockingCoreIssues.length > 0) {
      throw new Error(`Core tournament audit failed: ${blockingCoreIssues.join('; ')}`);
    }
    await runPhase('publish_standings', [], () =>
      tournamentInfoRepository.markStandingsReady(season, tournamentId, progressMarker),
    );
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
        setupExecution: execution,
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
    // The global reporting materialized view has its own cascade obligation.
    // It is intentionally not part of tournament setup: a slow or blocked
    // refresh must not roll back the canonical roster/group/points writes or
    // hold up My FPL FINAL readiness for unrelated tournaments.
    logInfo('Skipped global tournament materialized-view refresh during setup', {
      tournamentId,
    });
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
    const warningCount = await runPhase('publish_ready', [], async () => {
      const issueState = await tournamentSetupIssueRepository.sync(
        season,
        tournamentId,
        persistedIssues,
      );
      await finalizePublishedTournamentSetup(season, tournamentId, issueState.warningCount);
      await reserveRefresh();
      registerDatabasePostCommit(async () => {
        const unresolvedIssues = await tournamentSetupIssueRepository.listUnresolved(
          season,
          tournamentId,
        );
        await Promise.all(unresolvedIssues.map((issue) => enqueueTournamentRepair(season, issue)));
      });
      return issueState.warningCount;
    });
    outcome = setupIssues.length > 0 ? 'ready_with_warnings' : 'ready';
    logInfo('Tournament setup completed', {
      tournamentId,
      backfillStartEventId: window?.startEventId ?? null,
      backfillEndEventId: window?.endEventId ?? null,
      warnings: setupIssues.length,
      warningCount,
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
    // Each phase has already rolled back before control reaches this catch.
    // A statement error does not poison this new guarded publication phase.
    if (standingsPublished && failureCode !== 'TOURNAMENT_SETUP_EXECUTION_STALE') {
      await runPhase('publish_ready_with_warnings', [], async () => {
        const issueState = await tournamentSetupIssueRepository.sync(season, tournamentId, [
          normalizeTournamentSetupIssue({
            scope: 'event-results',
            message,
            failedEntries: setupEntryIds,
            diagnosticCode: failureCode,
          }),
        ]);
        await finalizePublishedTournamentSetup(season, tournamentId, issueState.warningCount);
        await reserveRefresh();
      });
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

export async function requeueTournamentSetup(
  season: FplSeasonRef,
  tournamentId: number,
  expectedSetupProgressUpdatedAt?: string | null,
) {
  const tournament = await tournamentInfoRepository.findSetupConfig(season, tournamentId);
  if (!tournament) {
    throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
  }

  // A prepared retry uses a marker-suffixed job ID. Reuse the current durable
  // marker for the admission check so a repeated request cannot miss that
  // waiting/active slot and prepare a second retry.
  const currentStatus = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
  const markerJob = currentStatus?.setupProgressUpdatedAt
    ? await findTournamentSetupJob(season, tournamentId, currentStatus.setupProgressUpdatedAt)
    : null;
  const admissionMarker = markerJob
    ? (currentStatus?.setupProgressUpdatedAt ?? undefined)
    : undefined;

  let retryStatePrepared = false;
  try {
    return await enqueueTournamentSetup(season, tournamentId, 'manual', {
      forceNew: true,
      ...(admissionMarker ? { admissionMarker } : {}),
      prepareEnqueue: async () => {
        const marker = await withMutationScopes(
          {
            queueName: 'tournament-management',
            jobName: 'tournament-setup-retry-prepare',
            tournamentId,
            scopes: [tournamentSetupLifecycleScope(tournamentId)],
          },
          async () => {
            const marked = await tournamentInfoRepository.markSetupRetryQueued(
              season,
              tournamentId,
              expectedSetupProgressUpdatedAt,
            );
            if (!marked) {
              throw new ConflictError(
                'Tournament state changed while setup retry was waiting to queue.',
                'TOURNAMENT_STATE_CHANGED',
              );
            }
            return marked;
          },
        );
        retryStatePrepared = true;
        return marker;
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
    let watchdogRecoveryMarker: string | null = null;
    let watchdogRecoveryPrepared = false;
    try {
      // Queue probes are candidates only. Keep all Redis/BullMQ calls outside
      // the lifecycle transaction; the durable marker and compare-and-swap
      // below fence a concurrent worker or owner change.
      if (isActive && (await isActive(row.id))) {
        skippedActive.push(row.id);
        logInfo('Skipping watchdog recovery after a live job appeared', {
          tournamentId: row.id,
          setupProgressUpdatedAt: row.setupProgressUpdatedAt,
        });
        continue;
      }

      // An inactive official-sync row with a pending/processing setup is
      // resume-owned. Replaying setup directly would rebuild from the old
      // roster and could activate the tournament without authoritative roster
      // publication. Replay the marker-pinned roster operation first; the
      // marked setup job will be enqueued by that operation.
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
          continue;
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
        continue;
      }

      // The stale query and BullMQ probe are only candidates. A worker may
      // advance its heartbeat before this short transaction is acquired, so
      // compare-and-swap the exact observed heartbeat before changing state.
      const marked = await withMutationScopes(
        {
          queueName: 'tournament-setup-watchdog',
          jobName: 'recover-stuck-setup',
          tournamentId: row.id,
          scopes: [tournamentSetupLifecycleScope(row.id)],
        },
        () =>
          tournamentInfoRepository.markStuckSetupQueuedIfUnchanged(
            season,
            row.id,
            row.setupProgressUpdatedAt,
            row.setupStartedAt,
            row.setupAttempt,
          ),
      );
      if (!marked) {
        logInfo('Skipping watchdog recovery after setup state advanced', {
          tournamentId: row.id,
          observedSetupProgressUpdatedAt: row.setupProgressUpdatedAt,
        });
        continue;
      }
      watchdogRecoveryMarker = marked;
      watchdogRecoveryPrepared = true;
      await enqueueTournamentSetup(season, row.id, 'watchdog', {
        forceNew: true,
        activeSettleTimeoutMs: 2_000,
        setupMarker: watchdogRecoveryMarker,
      });
      recovered.push(row.id);
      logInfo('Watchdog recovered stuck tournament setup', {
        tournamentId: row.id,
        setupProgressUpdatedAt: row.setupProgressUpdatedAt,
      });
    } catch (error) {
      if (watchdogRecoveryPrepared && watchdogRecoveryMarker) {
        await withMutationScopes(
          {
            queueName: 'tournament-setup-watchdog',
            jobName: 'restore-stuck-setup-after-enqueue-failure',
            tournamentId: row.id,
            scopes: [tournamentSetupLifecycleScope(row.id)],
          },
          () =>
            tournamentInfoRepository.restoreStuckSetupAfterEnqueueFailure(
              season,
              row.id,
              watchdogRecoveryMarker!,
              row.setupProgressUpdatedAt,
            ),
        ).catch((restoreError) => {
          logError('Watchdog failed to restore setup after queue admission failure', restoreError, {
            tournamentId: row.id,
            recoveryProgressUpdatedAt: watchdogRecoveryMarker,
          });
        });
      }
      logError('Watchdog failed to recover stuck tournament setup', error, {
        tournamentId: row.id,
      });
    }
  }

  return { recovered, skippedActive };
}
