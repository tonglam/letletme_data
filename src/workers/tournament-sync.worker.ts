import { Worker, Job, QueueEvents } from 'bullmq';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
import {
  getTournamentSyncQueueName,
  isTournamentSyncTieredQueueEnabled,
  tournamentSyncQueuesByTier,
  TOURNAMENT_JOBS,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import { syncTournamentEventResults } from '../services/tournament-event-results.service';
import { syncTournamentPointsRaceResults } from '../services/tournament-points-race-results.service';
import { syncTournamentBattleRaceResults } from '../services/tournament-battle-race-results.service';
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
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';
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
} from '../jobs/tournament-sync.jobs';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

/**
 * Enqueue cascade jobs after tournament-event-results completes.
 * These jobs depend on fresh tournament event results.
 *
 * MV refresh is NOT delayed-enqueued here: a fixed delay can fire between
 * serialized structure jobs. Instead points/battle/knockout share a cascade
 * barrier and the last successful one enqueues the refresh (FP-07).
 */
async function enqueueTournamentCascade(eventId: number) {
  logInfo('Enqueueing tournament cascade jobs', { eventId });

  try {
    const cascadeId = createCascadeId(eventId);
    await initCascadeStructureBarrier(cascadeId);
    const structureOpts = { cascadeId };

    // Structure jobs carry cascadeId for the MV barrier; cup/transfers do not.
    const results = await Promise.allSettled([
      enqueueTournamentPointsRace(eventId, 'cascade', structureOpts),
      enqueueTournamentBattleRace(eventId, 'cascade', structureOpts),
      enqueueTournamentKnockout(eventId, 'cascade', structureOpts),
      enqueueTournamentTransfersPost(eventId, 'cascade'),
      enqueueTournamentCupResults(eventId, 'cascade'),
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

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const jobNames = [
          'points-race',
          'battle-race',
          'knockout',
          'transfers-post',
          'cup-results',
        ];
        logError('Failed to enqueue cascade job', result.reason, {
          eventId,
          cascadeId,
          jobName: jobNames[index],
        });
      }
    });

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
    await maybeEnqueueCascadeMaterializedRefresh(eventId, cascadeId, 'structure-enqueue-gaps');
  } catch (error) {
    logError('Failed to enqueue tournament cascade jobs', error, { eventId });
    throw error;
  }
}

/**
 * Enqueue MV refresh once the structure barrier is complete.
 * Durable pending flag + lease: survives crashes after slot claim / failed queue.add.
 */
async function maybeEnqueueCascadeMaterializedRefresh(
  eventId: number,
  cascadeId: string,
  lastJob: string,
): Promise<void> {
  if (!(await tryClaimCascadeRefreshEnqueue(cascadeId))) {
    return;
  }
  try {
    await enqueueTournamentMaterializedViewsRefresh(eventId, 'cascade');
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
  eventId: number,
  cascadeId: string | undefined,
  jobName: string,
): Promise<void> {
  if (!cascadeId) {
    return;
  }
  // jobName is the stable barrier slot — retries of the same job no-op for DECR.
  await noteCascadeStructureJobComplete(cascadeId, jobName);
  // Retries still re-attempt enqueue if pending and not yet successfully enqueued.
  await maybeEnqueueCascadeMaterializedRefresh(eventId, cascadeId, jobName);
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
  const { eventId, source, cascadeId } = job.data;
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

  return withMutationConflictGuard(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      eventId,
    },
    () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case TOURNAMENT_JOBS.EVENT_RESULTS:
            // Base job: sync results then trigger cascade
            await syncTournamentEventResults(eventId);
            await enqueueTournamentCascade(eventId);
            break;

          case TOURNAMENT_JOBS.POINTS_RACE:
            await syncTournamentPointsRaceResults(eventId);
            await afterCascadeStructureJob(eventId, cascadeId, job.name);
            break;

          case TOURNAMENT_JOBS.BATTLE_RACE:
            await syncTournamentBattleRaceResults(eventId);
            await afterCascadeStructureJob(eventId, cascadeId, job.name);
            break;

          case TOURNAMENT_JOBS.KNOCKOUT:
            await syncTournamentKnockoutResults(eventId);
            await afterCascadeStructureJob(eventId, cascadeId, job.name);
            break;

          case TOURNAMENT_JOBS.TRANSFERS_POST:
            await syncTournamentEventTransfersPost(eventId);
            await enqueueTournamentSelectionStats(eventId, 'cascade');
            break;

          case TOURNAMENT_JOBS.CUP_RESULTS:
            await syncTournamentEventCupResults(eventId);
            break;

          case TOURNAMENT_JOBS.SELECTION_STATS:
            await syncTournamentSelectionStats(eventId);
            break;

          case TOURNAMENT_JOBS.EVENT_PICKS:
            await syncTournamentEventPicks(eventId);
            break;

          case TOURNAMENT_JOBS.TRANSFERS_PRE:
            await syncTournamentEventTransfersPre(eventId);
            break;

          case TOURNAMENT_JOBS.MATERIALIZED_VIEWS_REFRESH:
            await refreshTournamentMaterializedViews();
            break;

          case TOURNAMENT_JOBS.INFO:
            await syncTournamentInfo();
            break;

          default:
            throw new Error(`Unknown job name: ${job.name}`);
        }
      }),
  );
}

export function createTournamentSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isTournamentSyncTieredQueueEnabled
    ? MUTATION_PRIORITY_ORDER
    : (['p2'] as const);
  const workers: Worker<TournamentSyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getTournamentSyncQueueName(tier);
    const worker = new Worker<TournamentSyncJobData>(queueName, processTournamentSyncJob, {
      connection,
      concurrency: 10,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Tournament sync worker completed job', {
        jobId: job.id,
        jobName: job.name,
        eventId: job.data.eventId,
        tier,
      });
    });

    worker.on('failed', (job, err) => {
      logError('Tournament sync worker failed job', err, {
        jobId: job?.id,
        jobName: job?.name,
        eventId: job?.data.eventId,
        tier,
      });
    });

    worker.on('error', (err) => {
      logError('Tournament sync worker error', err, { tier });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: tournamentSyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'tournament-sync',
    {
      p0: { queue: tournamentSyncQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: tournamentSyncQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: tournamentSyncQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: tournamentSyncQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isTournamentSyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<TournamentSyncJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<TournamentSyncJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<TournamentSyncJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
