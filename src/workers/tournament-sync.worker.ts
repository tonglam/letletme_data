import { Worker, Job, QueueEvents } from 'bullmq';

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
import { isTerminalJobFailure } from '../utils/worker-failure';
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
  enqueueTournamentTransfersPost,
  enqueueTournamentCupResults,
  enqueueTournamentMaterializedViewsRefresh,
  enqueueTournamentSelectionStats,
  enqueueTournamentRosterSync,
} from '../jobs/tournament-sync.jobs';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';

type PostCommitIntent = () => Promise<void>;

type ScopedTournamentJobResult = {
  value: unknown;
  afterCommit?: PostCommitIntent;
};

const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

function startSchedulerLeaseHeartbeat(job: Job<TournamentSyncJobData>): () => void {
  const obligationId = job.data.obligationId;
  if (!obligationId) return () => undefined;

  const timer = setInterval(() => {
    void renewSchedulerObligation({
      obligationId,
      generation: job.data.obligationGeneration,
    }).catch((error) => {
      logError('Failed to renew tournament scheduler obligation lease', error, {
        jobId: job.id,
        jobName: job.name,
        obligationId,
        generation: job.data.obligationGeneration,
      });
    });
  }, SCHEDULER_LEASE_HEARTBEAT_MS);

  return () => clearInterval(timer);
}

/**
 * Enqueue cascade jobs after tournament-event-results completes.
 * These jobs depend on fresh tournament event results.
 *
 * MV refresh is NOT delayed-enqueued here: a fixed delay can fire between
 * serialized structure jobs. Instead points/battle/knockout share a cascade
 * barrier and the last successful one enqueues the refresh (FP-07).
 */
async function enqueueTournamentCascade(
  season: FplSeasonRef,
  eventId: number,
  finalizationTargets: TournamentFinalizationTarget[],
) {
  logInfo('Enqueueing tournament cascade jobs', { eventId });

  try {
    const cascadeId = createCascadeId(season, eventId);
    await initCascadeStructureBarrier(cascadeId);
    const structureOpts = { cascadeId, finalizationTargets };

    // Structure jobs carry cascadeId for the MV barrier; cup/transfers do not.
    const results = await Promise.allSettled([
      enqueueTournamentPointsRace(season, eventId, 'cascade', structureOpts),
      enqueueTournamentBattleRace(season, eventId, 'cascade', structureOpts),
      enqueueTournamentKnockout(season, eventId, 'cascade', structureOpts),
      enqueueTournamentTransfersPost(season, eventId, 'cascade', structureOpts),
      enqueueTournamentCupResults(season, eventId, 'cascade', structureOpts),
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

    // If a structure job failed to enqueue, the barrier would never reach 0.
    // Claim a stable enqueue-failed slot per job so a partial cascade still refreshes.
    const structureJobNames = [
      TOURNAMENT_JOBS.POINTS_RACE,
      TOURNAMENT_JOBS.BATTLE_RACE,
      TOURNAMENT_JOBS.KNOCKOUT,
    ];
    for (let i = 0; i < 3; i++) {
      if (results[i].status !== 'rejected') {
        continue;
      }
      await noteCascadeStructureJobComplete(cascadeId, `enqueue-failed:${structureJobNames[i]}`);
    }
    await maybeEnqueueCascadeMaterializedRefresh(
      season,
      eventId,
      cascadeId,
      'structure-enqueue-gaps',
      finalizationTargets,
    );
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
async function maybeEnqueueCascadeMaterializedRefresh(
  season: FplSeasonRef,
  eventId: number,
  cascadeId: string,
  lastJob: string,
  finalizationTargets: TournamentFinalizationTarget[],
): Promise<void> {
  const claim = await tryClaimCascadeRefreshEnqueue(cascadeId);
  if (claim === 'already-enqueued' || claim === 'not-pending') {
    return;
  }
  if (claim === 'lease-busy') {
    // Do not complete successfully behind a stale lease — retry until the
    // lease expires or the holder finishes markCascadeRefreshEnqueued.
    throw new Error(`Cascade MV refresh enqueue lease busy for cascadeId=${cascadeId}; will retry`);
  }
  try {
    await enqueueTournamentMaterializedViewsRefresh(season, eventId, 'cascade', {
      cascadeId,
      finalizationTargets,
    });
    await markCascadeRefreshEnqueued(cascadeId);
    logInfo('Enqueued tournament materialized views refresh after structure cascade', {
      eventId,
      cascadeId,
      lastJob,
    });
  } catch (error) {
    await releaseCascadeRefreshEnqueueClaim(cascadeId);
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
  jobName: string,
  finalizationTargets: TournamentFinalizationTarget[],
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
): Promise<void> {
  const event = await eventRepository.findById(season, eventId);
  if (!event?.finished || !event.dataChecked) {
    return;
  }

  await enqueueTournamentRosterSync(season, 'cascade', { finalizedEventId: eventId });
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
  const season = await requireCurrentSeasonForJob(job.data);
  const { eventId, source, cascadeId } = job.data;
  const finalizationTargets = job.data.finalizationTargets ?? [];
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
              await enqueueOfficialRosterSyncAfterFinalization(season, eventId);
              await enqueueTournamentCascade(season, eventId, result.finalizationTargets);
            } else {
              await enqueueOfficialRosterSyncAfterFinalization(season, eventId);
              await finalizeTournamentEventLifecycle(eventId, {
                ...tournamentEventFinalizationDependencies(season, []),
                // Recover a prior terminal write followed by a failed
                // derived-view refresh or cache invalidation.
                refreshAlways: true,
              });
            }
            return result;
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
                      job.name,
                      finalizationTargets,
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
                      job.name,
                      finalizationTargets,
                    ),
                };
              }

              case TOURNAMENT_JOBS.OFFICIAL_H2H:
                return { value: await syncOfficialH2HTournaments(season, eventId) };

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
                      job.name,
                      finalizationTargets,
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
                    });
                    await afterCascadeStructureJob(
                      season,
                      eventId,
                      cascadeId,
                      job.name,
                      finalizationTargets,
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
                      job.name,
                      finalizationTargets,
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
                      job.name,
                      finalizationTargets,
                    ),
                };
              }

              case TOURNAMENT_JOBS.EVENT_PICKS:
                return { value: await syncTournamentEventPicks(season, eventId) };

              case TOURNAMENT_JOBS.TRANSFERS_PRE:
                return { value: await syncTournamentEventTransfersPre(season, eventId) };

              case TOURNAMENT_JOBS.MATERIALIZED_VIEWS_REFRESH:
                return {
                  value: await finalizeTournamentEventLifecycle(eventId, {
                    ...tournamentEventFinalizationDependencies(season, finalizationTargets),
                    refreshAlways: true,
                  }),
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
            throw error;
          }
        }),
    );
  } finally {
    stopLeaseHeartbeat();
  }
}

export function createTournamentSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<TournamentSyncJobData>(
    tournamentSyncQueueName,
    processTournamentSyncJob,
    {
      connection,
      concurrency: 10,
      removeOnComplete: BULL_COMPLETED_RETENTION,
      removeOnFail: BULL_FAILED_RETENTION,
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    },
  );
  const queueEvents = new QueueEvents(tournamentSyncQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Tournament sync worker completed job', {
      jobId: job.id,
      jobName: job.name,
      eventId: job.data.eventId,
    });
    if (job.id !== undefined) {
      const completion = job.data.obligationId
        ? completeSchedulerObligation({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            status: 'succeeded',
            evidence: {
              queue: tournamentSyncQueueName,
              jobName: job.name,
              eventId: job.data.eventId,
            },
          })
        : completeSchedulerObligationByBullJobId({
            bullJobId: job.id,
            evidence: {
              queue: tournamentSyncQueueName,
              jobName: job.name,
              eventId: job.data.eventId,
            },
          });
      void completion.catch(() => undefined);
    }
  });
  worker.on('failed', (job, err) => {
    logError('Tournament sync worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
    });
    if (job) void alertOnFinalFailure(job, err);
    if (job && isTerminalJobFailure(job, err) && job.data.obligationId) {
      void failSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        error: err,
      }).catch(() => undefined);
    } else if (job?.id !== undefined && isTerminalJobFailure(job, err)) {
      void failSchedulerObligationByBullJobId({ bullJobId: job.id, error: err }).catch(
        () => undefined,
      );
    }
  });
  worker.on('error', (err) => logError('Tournament sync worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [
      { queue: tournamentSyncQueue, queueEvents, queueName: tournamentSyncQueueName },
    ],
  };
}
