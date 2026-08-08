import { Worker, Job, QueueEvents } from 'bullmq';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
import {
  shouldCascadePersistedLiveSnapshot,
  shouldSkipQueuedLiveSnapshot,
} from '../domain/live-snapshot';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  LIVE_JOBS,
  type LiveDataJobData,
  getLiveDataQueueName,
  isLiveDataTieredQueueEnabled,
  liveDataQueuesByTier,
} from '../queues/live-data.queue';
import {
  enqueueFinalLeagueResultsAfterLiveSync,
  isLiveMatchWindowForEvent,
} from '../services/live-data-cascade.service';
import { syncLiveSnapshot } from '../services/live-snapshot.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

/**
 * Live Data Worker
 *
 * Processes live data sync jobs:
 * - live-snapshot: coherent upstream fetch + atomic Redis publication (1-min)
 * - optional durable event-live persistence and the final-results cascade
 */
async function processLiveDataJob(job: Job<LiveDataJobData>) {
  const season = await requireCurrentSeasonForJob(job.data);
  const { eventId, source } = job.data;
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
        if (job.name !== LIVE_JOBS.LIVE_SNAPSHOT) {
          throw new Error(`Unknown job name: ${job.name}`);
        }
        const persistEventLives = job.data.persistEventLives ?? false;
        if (source === 'cron') {
          const windowOpen = await isLiveMatchWindowForEvent(season, eventId);
          if (shouldSkipQueuedLiveSnapshot(source, persistEventLives, windowOpen)) {
            logInfo('Skipping cache-only live snapshot job - not match time', {
              season: season.seasonCode,
              eventId,
            });
            return;
          }
        }
        const snapshot = await syncLiveSnapshot(season, eventId, {
          persistEventLives,
          finalizeEvent: job.data.finalizeEvent === true,
          trigger: source,
        });
        if (shouldCascadePersistedLiveSnapshot(snapshot)) {
          await enqueueFinalLeagueResultsAfterLiveSync(season, eventId);
        }
        return snapshot;
      }),
  );
}

export function createLiveDataWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isLiveDataTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p3'] as const);
  const workers: Worker<LiveDataJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getLiveDataQueueName(tier);
    const worker = new Worker<LiveDataJobData>(queueName, processLiveDataJob, {
      connection,
      concurrency: 5,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Live data worker completed job', {
        jobId: job.id,
        jobName: job.name,
        eventId: job.data.eventId,
        tier,
      });
    });

    worker.on('failed', (job, err) => {
      logError('Live data worker failed job', err, {
        jobId: job?.id,
        jobName: job?.name,
        eventId: job?.data.eventId,
        tier,
      });
      if (job) {
        void alertOnFinalFailure(job, err);
      }
    });

    worker.on('error', (err) => {
      logError('Live data worker error', err, { tier });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: liveDataQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'live-data',
    {
      p0: { queue: liveDataQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: liveDataQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: liveDataQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: liveDataQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isLiveDataTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<LiveDataJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<LiveDataJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<LiveDataJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
