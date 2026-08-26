import { Worker, Job, QueueEvents, type Queue } from 'bullmq';

import { finalizeTournamentEventLifecycle } from '../domain/tournament-event-finalization';
import type { FplSeasonRef } from '../domain/fpl-season';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { shouldEnqueueTournamentCascade } from '../domain/tournament-event-results';
import {
  tournamentSyncQueue,
  tournamentSyncQueueName,
  TOURNAMENT_JOBS,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import { syncTournamentEventResults } from '../services/tournament-event-results.service';
import { syncTournamentPointsRaceResults } from '../services/tournament-points-race-results.service';
import {
  enqueueOfficialH2HRosterRecoveries,
  getOfficialH2HFullReconcileTargets,
  getOfficialH2HRecoveryTargets,
  syncOfficialH2HTournaments,
  syncTournamentBattleRaceResults,
} from '../services/tournament-battle-race-results.service';
import { syncTournamentKnockoutResults } from '../services/tournament-knockout-results.service';
import {
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../services/tournament-event-transfers.service';
import { syncTournamentEventCupResults } from '../services/tournament-event-cup-results.service';
import { syncTournamentEventPicks } from '../services/tournament-event-picks.service';
import { syncTournamentInfo } from '../services/tournament-info.service';
import { refreshTournamentMaterializedViews } from '../services/tournament-materialized-views.service';
import { syncTournamentSelectionStats } from '../services/tournament-selection-stats.service';
import { eventRepository } from '../repositories/events';
import {
  finishTournamentsThroughEvent,
  reconcileOfficialTournamentRosters,
  reconcileTournamentRoster,
} from '../services/tournament-roster.service';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { resolveBullMqAttemptQueueWaitMs, runDataSyncAttempt } from '../utils/data-sync-attempt';
import { IncompleteDataSyncError } from '../utils/errors';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { isTerminalJobAttemptFailure, isTerminalJobFailure } from '../utils/worker-failure';
import { withMutationScopes } from '../utils/mutation-scopes';
import { resolveJobFreshAfter } from '../utils/job-freshness';
import {
  createCascadeId,
  initCascadeStructureBarrier,
  noteCascadeStructureJobComplete,
  tryClaimCascadeRefreshEnqueue,
  markCascadeRefreshEnqueued,
  releaseCascadeRefreshEnqueueClaim,
  enqueueTournamentPointsRace,
  enqueueTournamentBattleRace,
  enqueueTournamentKnockout,
  enqueueTournamentOfficialH2H,
  enqueueTournamentTransfersPost,
  enqueueTournamentCupResults,
  enqueueTournamentMaterializedViewsRefresh,
  enqueueTournamentSelectionStats,
  enqueueTournamentRosterSync,
  type CascadeCompletionBarrierJob,
} from '../jobs/tournament-sync.jobs';
import type { WorkerRuntime } from './worker-runtime';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';
import { openGovernanceCase } from '../services/data-governance.service';

type PostCommitIntent = () => Promise<void>;

type ScopedTournamentJobResult = {
  value: unknown;
  afterCommit?: PostCommitIntent;
};

type CascadeObligation = Readonly<{
  obligationId?: string;
  obligationGeneration?: number;
}>;

export type TournamentCascadeEnqueueDependencies = Readonly<{
  createId: typeof createCascadeId;
  initBarrier: typeof initCascadeStructureBarrier;
  enqueuePointsRace: typeof enqueueTournamentPointsRace;
  enqueueBattleRace: typeof enqueueTournamentBattleRace;
  enqueueKnockout: typeof enqueueTournamentKnockout;
  enqueueTransfersPost: typeof enqueueTournamentTransfersPost;
  enqueueCupResults: typeof enqueueTournamentCupResults;
}>;

const tournamentCascadeEnqueueDependencies: TournamentCascadeEnqueueDependencies = {
  createId: createCascadeId,
  initBarrier: initCascadeStructureBarrier,
  enqueuePointsRace: enqueueTournamentPointsRace,
  enqueueBattleRace: enqueueTournamentBattleRace,
  enqueueKnockout: enqueueTournamentKnockout,
  enqueueTransfersPost: enqueueTournamentTransfersPost,
  enqueueCupResults: enqueueTournamentCupResults,
};

export type CascadeRefreshDependencies = Readonly<{
  claim: typeof tryClaimCascadeRefreshEnqueue;
  enqueue: typeof enqueueTournamentMaterializedViewsRefresh;
  markEnqueued: typeof markCascadeRefreshEnqueued;
  releaseClaim: typeof releaseCascadeRefreshEnqueueClaim;
}>;

const cascadeRefreshDependencies: CascadeRefreshDependencies = {
  claim: tryClaimCascadeRefreshEnqueue,
  enqueue: enqueueTournamentMaterializedViewsRefresh,
  markEnqueued: markCascadeRefreshEnqueued,
  releaseClaim: releaseCascadeRefreshEnqueueClaim,
};

const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

function startSchedulerLeaseHeartbeat(job: Job<TournamentSyncJobData>): () => void {
  const fence = inspectSchedulerObligationFence(job.data);
  if (fence.kind !== 'complete') return () => undefined;

  const timer = setInterval(() => {
    void renewSchedulerObligation({
      obligationId: fence.obligationId,
      generation: fence.generation,
    }).catch((error) => {
      logError('Failed to renew tournament scheduler obligation lease', error, {
        jobId: job.id,
        jobName: job.name,
        obligationId: fence.obligationId,
        generation: fence.generation,
      });
    });
  }, SCHEDULER_LEASE_HEARTBEAT_MS);

  return () => clearInterval(timer);
}

async function completeTournamentCascadeObligation(
  job: Job<TournamentSyncJobData>,
  completionStage: 'no-active-tournaments' | 'materialized-view-finalizer',
): Promise<void> {
  const fence = inspectSchedulerObligationFence(job.data);
  if (fence.kind !== 'complete') return;
  const completed = await completeSchedulerObligation({
    obligationId: fence.obligationId,
    generation: fence.generation,
    status: 'succeeded',
    evidence: {
      queue: job.queueName,
      jobName: job.name,
      eventId: job.data.eventId,
      cascadeId: job.data.cascadeId,
      completionStage,
    },
  });
  if (!completed) {
    logInfo('Ignored stale tournament obligation completion', {
      obligationId: fence.obligationId,
      generation: fence.generation,
      jobName: job.name,
      completionStage,
    });
  }
}

export async function persistTournamentTerminalFailureBeforeSettlement(
  job: Pick<Job<TournamentSyncJobData>, 'attemptsMade' | 'opts' | 'data'>,
  error: unknown,
  persist: typeof failSchedulerObligation = failSchedulerObligation,
): Promise<boolean> {
  const fence = inspectSchedulerObligationFence(job.data);
  if (fence.kind !== 'complete' || !isTerminalJobAttemptFailure(job, error, job.attemptsMade + 1)) {
    return false;
  }
  return persist({
    obligationId: fence.obligationId,
    generation: fence.generation,
    error,
  });
}

/**
 * Enqueue cascade jobs after tournament-event-results completes.
 * These jobs depend on fresh tournament event results.
 *
 * MV refresh is NOT delayed-enqueued here: a fixed delay can fire between
 * serialized structure jobs. Instead points/battle/knockout share a cascade
 * barrier and the last successful one enqueues the refresh (FP-07).
 */
export async function enqueueTournamentCascade(
  season: FplSeasonRef,
  eventId: number,
  finalizationTargets: TournamentFinalizationTarget[],
  runId?: string,
  obligation: CascadeObligation = {},
  dependencies: TournamentCascadeEnqueueDependencies = tournamentCascadeEnqueueDependencies,
) {
  logInfo('Enqueueing tournament cascade jobs', { eventId });

  try {
    const cascadeId = dependencies.createId();
    await dependencies.initBarrier(cascadeId);
    const structureOpts = {
      cascadeId,
      finalizationTargets,
      runId,
      ...(obligation.obligationId ? { obligationId: obligation.obligationId } : {}),
      ...(obligation.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: obligation.obligationGeneration }),
    };

    // All five roots carry the cascade and scheduler generation. Transfers
    // enqueues the sixth role (selection stats) only after its own write.
    const results = await Promise.allSettled([
      dependencies.enqueuePointsRace(season, eventId, 'cascade', structureOpts),
      dependencies.enqueueBattleRace(season, eventId, 'cascade', structureOpts),
      dependencies.enqueueKnockout(season, eventId, 'cascade', structureOpts),
      dependencies.enqueueTransfersPost(season, eventId, 'cascade', structureOpts),
      dependencies.enqueueCupResults(season, eventId, 'cascade', structureOpts),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logInfo('Tournament cascade jobs enqueued', {
      eventId,
      cascadeId,
      total: results.length,
      successful,
      failed,
    });

    if (failed > 0) {
      const jobNames = ['points-race', 'battle-race', 'knockout', 'transfers-post', 'cup-results'];
      const failures = results
        .map((result, index) => ({ result, jobName: jobNames[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, jobName }) => ({
          jobName,
          reason: result.status === 'rejected' ? result.reason : null,
        }));
      failures.forEach(({ jobName, reason }) => {
        logError('Failed to enqueue cascade job', reason, {
          eventId,
          cascadeId,
          jobName,
        });
      });
      throw new Error(
        `Tournament cascade enqueue failed for ${failed} job(s) (eventId=${eventId})`,
      );
    }
  } catch (error) {
    logError('Failed to enqueue tournament cascade jobs', error, { eventId });
    throw error;
  }
}

/**
 * Enqueue MV refresh once the structure barrier is complete.
 * Durable pending flag + lease: survives crashes after slot claim / failed queue.add.
 * If the lease is held by a dead worker, throw so BullMQ retries (Codex P2).
 */
export async function maybeEnqueueCascadeMaterializedRefresh(
  season: FplSeasonRef,
  eventId: number,
  cascadeId: string,
  lastJob: string,
  finalizationTargets: TournamentFinalizationTarget[],
  runId?: string,
  obligation: CascadeObligation = {},
  dependencies: CascadeRefreshDependencies = cascadeRefreshDependencies,
): Promise<void> {
  const claim = await dependencies.claim(cascadeId);
  if (claim === 'already-enqueued' || claim === 'not-pending') {
    return;
  }
  if (claim === 'lease-busy') {
    // Do not complete successfully behind a stale lease — retry until the
    // lease expires or the holder finishes markCascadeRefreshEnqueued.
    throw new Error(`Cascade MV refresh enqueue lease busy for cascadeId=${cascadeId}; will retry`);
  }
  try {
    await dependencies.enqueue(season, eventId, 'cascade', {
      cascadeId,
      finalizationTargets,
      runId,
      ...(obligation.obligationId ? { obligationId: obligation.obligationId } : {}),
      ...(obligation.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: obligation.obligationGeneration }),
    });
    await dependencies.markEnqueued(cascadeId);
    logInfo('Enqueued tournament materialized views refresh after structure cascade', {
      eventId,
      cascadeId,
      lastJob,
    });
  } catch (error) {
    await dependencies.releaseClaim(cascadeId);
    logError('Failed to enqueue materialized views refresh after structure cascade', error, {
      eventId,
      cascadeId,
      lastJob,
    });
    throw error;
  }
}

/** After a structure cascade job succeeds, maybe enqueue MV refresh. */
async function afterCascadeStructureJob(
  season: FplSeasonRef,
  eventId: number,
  cascadeId: string | undefined,
  jobName: CascadeCompletionBarrierJob,
  finalizationTargets: TournamentFinalizationTarget[],
  runId?: string,
  obligation: CascadeObligation = {},
): Promise<void> {
  if (!cascadeId) {
    return;
  }
  // jobName is the stable barrier slot — retries of the same job no-op for DECR.
  await noteCascadeStructureJobComplete(cascadeId, jobName);
  // Retries still re-attempt enqueue if pending and not yet successfully enqueued.
  await maybeEnqueueCascadeMaterializedRefresh(
    season,
    eventId,
    cascadeId,
    jobName,
    finalizationTargets,
    runId,
    obligation,
  );
}

export function assertTournamentStructureSyncComplete(
  result: { skipped: number },
  eventId: number,
  jobName: string,
): void {
  if (result.skipped > 0) {
    throw new Error(`${jobName} skipped ${result.skipped} required unit(s) for event ${eventId}`);
  }
}

function tournamentEventFinalizationDependencies(
  season: FplSeasonRef,
  finalizationTargets: TournamentFinalizationTarget[],
) {
  return {
    finish: (eventId: number) =>
      finishTournamentsThroughEvent(season, eventId, finalizationTargets),
    refresh: refreshTournamentMaterializedViews,
  };
}

async function enqueueOfficialRosterSyncAfterFinalization(
  season: FplSeasonRef,
  eventId: number,
  runId?: string,
): Promise<void> {
  const event = await eventRepository.findById(season, eventId);
  if (!event?.finished || !event.dataChecked) {
    return;
  }

  await enqueueTournamentRosterSync(season, 'cascade', { finalizedEventId: eventId, runId });
  logInfo('Enqueued official tournament roster reconcile after finalized event', {
    season: season.seasonCode,
    eventId,
  });
}

/**
 * Tournament Sync Worker
 *
 * Processes tournament sync jobs:
 * - Base job (event-results): Triggers cascade on completion
 * - Cascade jobs: Run in parallel after base completes
 * - Independent jobs: Run on separate schedule
 *
 * Architecture:
 * event-results (base) → [points-race, battle-race, knockout, transfers-post, cup-results] (parallel)
 */
async function processTournamentSyncJob(job: Job<TournamentSyncJobData>) {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }
  const season = await requireCurrentSeasonForJob(job.data);
  const { eventId, source, cascadeId } = job.data;
  const finalizationTargets = job.data.finalizationTargets ?? [];
  const cascadeObligation: CascadeObligation = {
    ...(job.data.obligationId ? { obligationId: job.data.obligationId } : {}),
    ...(job.data.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: job.data.obligationGeneration }),
  };
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
  };

  logJobTriggered(context);

  const stopLeaseHeartbeat = startSchedulerLeaseHeartbeat(job);
  try {
    return await runDataSyncAttempt(
      {
        queue: job.queueName,
        jobName: job.name,
        runId: String(job.id ?? `${job.name}-${job.timestamp}`),
        source,
        attempt: job.attemptsMade + 1,
        targetEventId: eventId,
        queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
      },
      () =>
        runTrackedJob(context, async () => {
          const mutationInput = {
            queueName: job.queueName,
            jobName: job.name,
            jobId: String(job.id),
            eventId,
          };

          // Event-results catch-up is an entry-scoped batch.  Do not wrap the
          // whole network-heavy batch in one mutation transaction: each entry
          // persists under a short entry-core scope in the service, while a
          // long-lived outer transaction would retain multiple advisory locks
          // and deadlock against entry-info.  The service resolves every
          // per-entry write before this branch hands off any dependent jobs.
          if (job.name === TOURNAMENT_JOBS.EVENT_RESULTS) {
            const freshAfter = await resolveJobFreshAfter(job);
            const result = await syncTournamentEventResults(season, eventId, {
              freshAfter,
              perEntryMutationScopes: true,
            });
            if (!shouldEnqueueTournamentCascade(result)) {
              logInfo('Skipping tournament cascade - no active tournament entries', {
                eventId,
              });
            }
            if (shouldEnqueueTournamentCascade(result)) {
              await enqueueOfficialRosterSyncAfterFinalization(season, eventId, job.data.runId);
              await enqueueTournamentCascade(
                season,
                eventId,
                result.finalizationTargets,
                job.data.runId,
                cascadeObligation,
              );
            } else {
              await enqueueOfficialRosterSyncAfterFinalization(season, eventId, job.data.runId);
              await finalizeTournamentEventLifecycle(eventId, {
                ...tournamentEventFinalizationDependencies(season, []),
                // Recover a prior terminal write followed by a failed
                // derived-view refresh or cache invalidation.
                refreshAlways: true,
              });
              await completeTournamentCascadeObligation(job, 'no-active-tournaments');
            }
            return result;
          }

          // This stage fetches one mutable FPL transfer history per tournament
          // entry. Keep those requests outside the event-wide mutation
          // transaction; the service acquires the same event scopes only for
          // each short canonical write and the final trend publication.
          if (job.name === TOURNAMENT_JOBS.TRANSFERS_PRE) {
            const freshAfter = await resolveJobFreshAfter(job);
            return syncTournamentEventTransfersPre(season, eventId, {
              freshAfter,
              perEntryMutationScopes: true,
              mutationJobId: String(job.id),
            });
          }

          const runMutation = async (): Promise<ScopedTournamentJobResult> => {
            switch (job.name) {
              case TOURNAMENT_JOBS.POINTS_RACE: {
                const result = await syncTournamentPointsRaceResults(season, eventId);
                assertTournamentStructureSyncComplete(result, eventId, job.name);
                return {
                  value: result,
                  afterCommit: () =>
                    afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.POINTS_RACE,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    ),
                };
              }

              case TOURNAMENT_JOBS.BATTLE_RACE: {
                const battleResult = await syncTournamentBattleRaceResults(season, eventId);
                assertTournamentStructureSyncComplete(battleResult, eventId, job.name);
                return {
                  value: battleResult,
                  afterCommit: () =>
                    afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.BATTLE_RACE,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    ),
                };
              }

              case TOURNAMENT_JOBS.OFFICIAL_H2H:
                return {
                  value: await syncOfficialH2HTournaments(season, eventId, {
                    forceFull: job.data.officialH2HMode === 'full-reconcile',
                    ...(job.data.tournamentId === undefined
                      ? {}
                      : { tournamentId: job.data.tournamentId }),
                  }),
                };

              case TOURNAMENT_JOBS.KNOCKOUT: {
                const result = await syncTournamentKnockoutResults(season, eventId);
                assertTournamentStructureSyncComplete(result, eventId, job.name);
                return {
                  value: result,
                  afterCommit: () =>
                    afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.KNOCKOUT,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    ),
                };
              }

              case TOURNAMENT_JOBS.TRANSFERS_POST: {
                const result = await syncTournamentEventTransfersPost(season, eventId);
                return {
                  value: result,
                  afterCommit: async () => {
                    await enqueueTournamentSelectionStats(season, eventId, 'cascade', {
                      cascadeId,
                      finalizationTargets,
                      runId: job.data.runId,
                      ...cascadeObligation,
                    });
                    await afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.TRANSFERS_POST,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    );
                  },
                };
              }

              case TOURNAMENT_JOBS.CUP_RESULTS: {
                const result = await syncTournamentEventCupResults(season, eventId);
                return {
                  value: result,
                  afterCommit: () =>
                    afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.CUP_RESULTS,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    ),
                };
              }

              case TOURNAMENT_JOBS.SELECTION_STATS: {
                const result = await syncTournamentSelectionStats(season, eventId);
                return {
                  value: result,
                  afterCommit: () =>
                    afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      TOURNAMENT_JOBS.SELECTION_STATS,
                      finalizationTargets,
                      job.data.runId,
                      cascadeObligation,
                    ),
                };
              }

              case TOURNAMENT_JOBS.EVENT_PICKS:
                return { value: await syncTournamentEventPicks(season, eventId) };

              case TOURNAMENT_JOBS.MATERIALIZED_VIEWS_REFRESH:
                return {
                  value: await finalizeTournamentEventLifecycle(eventId, {
                    ...tournamentEventFinalizationDependencies(season, finalizationTargets),
                    refreshAlways: true,
                  }),
                  afterCommit: () =>
                    completeTournamentCascadeObligation(job, 'materialized-view-finalizer'),
                };

              case TOURNAMENT_JOBS.INFO:
                return { value: await syncTournamentInfo(season) };

              case TOURNAMENT_JOBS.ROSTER_SYNC: {
                const result = await reconcileOfficialTournamentRosters(season);
                if (result.errors > 0) {
                  throw new IncompleteDataSyncError(
                    'Official tournament roster synchronization did not converge',
                    result.total,
                    result.skipped,
                    result.changed,
                    result.errors,
                  );
                }
                return { value: result };
              }

              case TOURNAMENT_JOBS.ROSTER_RECONCILE: {
                if (!job.data.tournamentId) {
                  throw new Error('Roster reconcile job is missing tournamentId');
                }
                try {
                  return {
                    value: await reconcileTournamentRoster(season, job.data.tournamentId, {
                      allowInactive: job.data.allowInactive === true,
                      resumeAfterSetup: job.data.resumeAfterSetup === true,
                      resumeMarker: job.data.resumeMarker,
                      requireResumeMarker: job.data.resumeAfterSetup === true,
                      settleBoundaryFailure: job.data.settleBoundaryFailure === true,
                      allowUnlockedOfficialH2HRecovery:
                        job.data.allowUnlockedOfficialH2HRecovery === true,
                      expectedProgressMarker: job.data.expectedProgressMarker,
                    }),
                  };
                } catch (error) {
                  // Deletion is authoritative. A reconcile accepted just before
                  // delete must settle successfully, not retry and alert on a
                  // deliberately missing tournament.
                  if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'TOURNAMENT_NOT_FOUND'
                  ) {
                    logInfo('Ignoring roster reconcile for deleted tournament', {
                      tournamentId: job.data.tournamentId,
                    });
                    return {
                      value: {
                        tournamentId: job.data.tournamentId,
                        changed: false,
                        addedEntryIds: [],
                        removedEntryIds: [],
                        participantCount: 0,
                        automaticallyPaused: false,
                      },
                    };
                  }
                  if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'TOURNAMENT_FINISHED'
                  ) {
                    await tournamentRosterRepository.markSyncCanceled(
                      season,
                      job.data.tournamentId,
                    );
                    logInfo('Ignoring roster reconcile for finished tournament', {
                      tournamentId: job.data.tournamentId,
                    });
                    return {
                      value: {
                        tournamentId: job.data.tournamentId,
                        changed: false,
                        addedEntryIds: [],
                        removedEntryIds: [],
                        participantCount: 0,
                        automaticallyPaused: false,
                      },
                    };
                  }
                  throw error;
                }
              }

              default:
                throw new Error(`Unknown job name: ${job.name}`);
            }
          };

          // Roster reconciliation owns its own short publication scope and
          // performs setup enqueueing after that commit. Do not wrap it in a
          // second outer transaction that would hold the scope through the queue
          // handoff.
          if (
            job.name === TOURNAMENT_JOBS.ROSTER_SYNC ||
            job.name === TOURNAMENT_JOBS.ROSTER_RECONCILE
          ) {
            return (await runMutation()).value;
          }

          try {
            const scoped = await withMutationScopes(mutationInput, runMutation);
            if (scoped.afterCommit) await scoped.afterCommit();
            return scoped.value;
          } catch (error) {
            const recoveryTargets =
              job.name === TOURNAMENT_JOBS.OFFICIAL_H2H ? getOfficialH2HRecoveryTargets(error) : [];
            if (recoveryTargets.length > 0) {
              // The official-H2H mutation transaction has rolled back and
              // released its structure locks. Persist the recovery fence before
              // publishing the Redis job so the worker can claim it reliably.
              await enqueueOfficialH2HRosterRecoveries(season, eventId, recoveryTargets);
            }
            const fullReconcileTargets =
              job.name === TOURNAMENT_JOBS.OFFICIAL_H2H
                ? getOfficialH2HFullReconcileTargets(error)
                : [];
            if (fullReconcileTargets.length > 0) {
              await Promise.all(
                fullReconcileTargets.map(async (target) => {
                  const hash = target.lockedScheduleHash ?? 'unknown';
                  try {
                    await openGovernanceCase({
                      caseKind: 'h2h-schedule-drift',
                      contractKey: 'official-h2h',
                      lane: 'official-h2h-live',
                      scopeKey: `${season.seasonCode}:tournament:${target.tournamentId}`,
                      errorClass: 'CONTRACT_DRIFT',
                      errorCode: 'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_CHANGED',
                      fingerprint: `official-h2h:${season.seasonCode}:${target.tournamentId}:${hash}`,
                      evidence: {
                        eventId,
                        lockedScheduleHash: target.lockedScheduleHash,
                        reconciliation: 'full',
                      },
                      repairTarget: {
                        tournamentId: target.tournamentId,
                        eventId,
                        lockedScheduleHash: target.lockedScheduleHash,
                      },
                      compensator: 'protected official H2H full reconciliation',
                    });
                  } catch (caseError) {
                    // The original transaction has already rolled back. A
                    // missing case must not turn a deterministic drift signal
                    // into a different worker failure; the next audit can
                    // recreate the same fingerprint.
                    logError('Failed to persist official H2H drift governance case', caseError, {
                      eventId,
                      tournamentId: target.tournamentId,
                    });
                  }
                }),
              );
              if (job.data.officialH2HMode === 'full-reconcile') {
                // A guarded full reconciliation that still sees drift is now
                // a review case. Do not enqueue another self-referential job.
                throw error;
              }
              // A locked-page drift aborts the current transaction. Requeue
              // exactly one guarded full root per tournament/hash; the full
              // root may refresh an unchanged manifest, but a changed locked
              // hash remains a review case and cannot publish partial rows.
              await Promise.all(
                fullReconcileTargets.map(async (target) => {
                  const hash = target.lockedScheduleHash ?? 'unknown';
                  const reconcileKey = `full-reconcile:${target.tournamentId}:${hash}`;
                  try {
                    const fullJob = await enqueueTournamentOfficialH2H(
                      season,
                      eventId,
                      'reconcile',
                      {
                        tournamentId: target.tournamentId,
                        officialH2HMode: 'full-reconcile',
                        officialH2HReconcileKey: reconcileKey,
                        // BullMQ job IDs cannot contain a colon. Keep the
                        // human-readable reconcile key in job data, but use a
                        // delimiter-safe deterministic identity for Bull.
                        jobId: `official-h2h-${reconcileKey.replaceAll(':', '-')}`,
                      },
                    );
                    logInfo('Enqueued guarded official H2H full reconciliation', {
                      eventId,
                      tournamentId: target.tournamentId,
                      reconcileKey,
                      jobId: fullJob?.id,
                    });
                  } catch (reconcileError) {
                    logError('Failed to enqueue official H2H full reconciliation', reconcileError, {
                      eventId,
                      tournamentId: target.tournamentId,
                    });
                  }
                }),
              );
            }
            throw error;
          }
        }),
    );
  } catch (error) {
    const fence = inspectSchedulerObligationFence(job.data);
    if (fence.kind === 'complete') {
      try {
        await persistTournamentTerminalFailureBeforeSettlement(job, error);
      } catch (bookkeepingError) {
        // The BullMQ failed listener remains an idempotent fallback, but the
        // main path attempts durable failure bookkeeping before settlement so
        // process exit cannot leave a false active obligation.
        logError(
          'Failed to persist tournament obligation failure before settlement',
          bookkeepingError,
          {
            jobId: job.id,
            jobName: job.name,
            obligationId: fence.obligationId,
            generation: fence.generation,
          },
        );
      }
    }
    throw error;
  } finally {
    stopLeaseHeartbeat();
  }
}

export function shouldCompleteTournamentJobOnSettlement(
  job: Pick<Job<TournamentSyncJobData>, 'name' | 'data'>,
): boolean {
  // Event-results either completes explicitly after the no-active finalizer or
  // hands ownership to its cascade. Every cascade child, including the MV
  // finalizer, persists its own guarded terminal state before BullMQ settles.
  return job.name !== TOURNAMENT_JOBS.EVENT_RESULTS && job.data.source !== 'cascade';
}

export function createTournamentSyncWorker(
  input: {
    queue?: Queue<TournamentSyncJobData>;
    queueName?: string;
    concurrency?: number;
  } = {},
): WorkerRuntime {
  const connection = getQueueConnection();
  const workerQueue = input.queue ?? tournamentSyncQueue;
  const workerQueueName = input.queueName ?? tournamentSyncQueueName;
  const worker = new Worker<TournamentSyncJobData>(workerQueueName, processTournamentSyncJob, {
    connection,
    concurrency: input.concurrency ?? 10,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(workerQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Tournament sync worker completed job', {
      jobId: job.id,
      jobName: job.name,
      eventId: job.data.eventId,
    });
    if (job.id !== undefined && shouldCompleteTournamentJobOnSettlement(job)) {
      const fence = inspectSchedulerObligationFence(job.data);
      const evidence = {
        queue: workerQueueName,
        jobName: job.name,
        eventId: job.data.eventId,
      };
      const completion =
        fence.kind === 'complete'
          ? completeSchedulerObligation({
              obligationId: fence.obligationId,
              generation: fence.generation,
              status: 'succeeded',
              evidence,
            })
          : fence.kind === 'none'
            ? completeSchedulerObligationByBullJobId({ bullJobId: job.id, evidence })
            : null;
      if (completion) void completion.catch(() => undefined);
    }
  });
  worker.on('failed', (job, err) => {
    logError('Tournament sync worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
    });
    if (job) void alertOnFinalFailure(job, err);
    const fence = job ? inspectSchedulerObligationFence(job.data) : null;
    if (job && isTerminalJobFailure(job, err) && fence?.kind === 'complete') {
      void failSchedulerObligation({
        obligationId: fence.obligationId,
        generation: fence.generation,
        error: err,
      }).catch(() => undefined);
    } else if (job?.id !== undefined && isTerminalJobFailure(job, err) && fence?.kind === 'none') {
      void failSchedulerObligationByBullJobId({ bullJobId: job.id, error: err }).catch(
        () => undefined,
      );
    }
  });
  worker.on('error', (err) => logError('Tournament sync worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: workerQueue, queueEvents, queueName: workerQueueName }],
  };
}
