import { Worker, Job, QueueEvents } from 'bullmq';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
import {
  getLeagueSyncQueueName,
  isLeagueSyncTieredQueueEnabled,
  leagueSyncQueuesByTier,
  LEAGUE_JOBS,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import {
  processLeagueEventPicksJob,
  processLeagueEventResultsJob,
} from '../services/league-sync.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { alertOnFinalFailure } from '../utils/notify';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

/**
 * League Sync Worker
 *
 * Processes league sync jobs:
 * - Coordinator job (no tournamentId): Enqueues one job per tournament
 * - Tournament job (with tournamentId): Processes that specific tournament
 */
async function processLeagueSyncJob(job: Job<LeagueSyncJobData>) {
  const { eventId, tournamentId, source } = job.data;
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
    tournamentId,
  };

  logJobTriggered(context);

  return withMutationConflictGuard(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      eventId,
      tournamentId,
    },
    () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case LEAGUE_JOBS.LEAGUE_EVENT_PICKS:
            return processLeagueEventPicksJob(eventId, tournamentId);

          case LEAGUE_JOBS.LEAGUE_EVENT_RESULTS:
            return processLeagueEventResultsJob(eventId, tournamentId);

          default:
            throw new Error(`Unknown job name: ${job.name}`);
        }
      }),
  );
}

export function createLeagueSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isLeagueSyncTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p3'] as const);
  const workers: Worker<LeagueSyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getLeagueSyncQueueName(tier);
    const worker = new Worker<LeagueSyncJobData>(queueName, processLeagueSyncJob, {
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
      logInfo('League sync worker completed job', {
        jobId: job.id,
        jobName: job.name,
        eventId: job.data.eventId,
        tournamentId: job.data.tournamentId,
        tier,
      });
    });

    worker.on('failed', (job, err) => {
      logError('League sync worker failed job', err, {
        jobId: job?.id,
        jobName: job?.name,
        eventId: job?.data.eventId,
        tournamentId: job?.data.tournamentId,
        tier,
      });
      if (job) {
        void alertOnFinalFailure({
          queueName: job.queueName,
          jobName: job.name,
          jobId: String(job.id),
          attemptsMade: job.attemptsMade,
          attempts: job.opts.attempts ?? 1,
          tier,
          error: err,
        });
      }
    });

    worker.on('error', (err) => {
      logError('League sync worker error', err, { tier });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: leagueSyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'league-sync',
    {
      p0: { queue: leagueSyncQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: leagueSyncQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: leagueSyncQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: leagueSyncQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isLeagueSyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<LeagueSyncJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<LeagueSyncJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<LeagueSyncJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
