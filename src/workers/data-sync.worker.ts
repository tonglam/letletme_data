import { QueueEvents, Worker, type Job } from 'bullmq';

import { MUTATION_PRIORITY_ORDER } from '../domain/job-priority';
import {
  type DataSyncJobData,
  dataSyncQueuesByTier,
  getDataSyncQueueName,
  isDataSyncTieredQueueEnabled,
} from '../queues/data-sync.queue';
import { syncPlayerPricesForDate } from '../services/player-prices.service';
import { syncCurrentPlayerStats, syncPlayerStatsForEvent } from '../services/player-stats.service';
import { syncCurrentPlayerValues } from '../services/player-values.service';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import { prepareAndArchiveFplSeason } from '../services/fpl-history.service';
import {
  resolveBullMqAttemptQueueWaitMs,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { formatCronDateKey } from '../utils/timezone';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

const CORE_SNAPSHOT_JOB_NAMES = new Set([
  'core-snapshot',
  'events',
  'fixtures',
  'fixtures-all-gameweeks',
  'teams',
  'players',
  'phases',
  'fpl-season-archive',
]);

const processDataSyncJob = async (job: Job<DataSyncJobData>) => {
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data?.source as string | undefined,
    attempt: job.attemptsMade + 1,
    queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
  };
  const attemptContext: DataSyncAttemptContext = {
    queue: job.queueName,
    jobName: job.name,
    runId: job.data?.runId ?? String(job.id ?? `${job.name}-${job.timestamp}`),
    source: job.data?.source,
    attempt: job.attemptsMade + 1,
    targetEventId: job.data?.eventId,
    queueWaitMs: context.queueWaitMs,
  };
  const recordResolvedTarget = (eventId: number) => {
    attemptContext.targetEventId = eventId;
  };

  logJobTriggered(context);

  return runDataSyncAttempt(attemptContext, () => {
    const execute = () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case 'core-snapshot':
          case 'events':
          case 'fixtures':
          case 'fixtures-all-gameweeks':
          case 'teams':
          case 'players':
          case 'phases':
            return syncCoreSnapshot();
          case 'player-prices':
            if (!job.data.changeDate) {
              throw new Error('player-prices job requires changeDate');
            }
            return syncPlayerPricesForDate(job.data.changeDate);
          case 'player-stats':
            return job.data.eventId !== undefined
              ? syncPlayerStatsForEvent(job.data.eventId)
              : syncCurrentPlayerStats({ onTargetEventResolved: recordResolvedTarget });
          case 'player-values':
            return syncCurrentPlayerValues(
              job.data.changeDate ?? formatCronDateKey(new Date(job.data.triggeredAt)),
              { onTargetEventResolved: recordResolvedTarget },
            );
          case 'fpl-season-archive':
            if (!job.data.season) throw new Error('fpl-season-archive job requires season');
            return prepareAndArchiveFplSeason(job.data.season);
          default:
            throw new Error(`Unknown data-sync job: ${job.name}`);
        }
      });

    // Core aliases perform upstream reads before acquiring their own short
    // multi-table persistence/publication lock.
    if (CORE_SNAPSHOT_JOB_NAMES.has(job.name)) return execute();
    return withMutationConflictGuard(
      {
        queueName: job.queueName,
        jobName: job.name,
        jobId: String(job.id),
      },
      execute,
    );
  });
};

export function createDataSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isDataSyncTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p1'] as const);
  const workers: Worker<DataSyncJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getDataSyncQueueName(tier);
    const worker = new Worker<DataSyncJobData>(queueName, processDataSyncJob, {
      connection,
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Data sync job completed', { jobId: job.id, name: job.name, tier });
    });

    worker.on('failed', (job, error) => {
      logError('Data sync job failed', error, {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        tier,
      });
      if (job) {
        void alertOnFinalFailure(job, error);
      }
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: dataSyncQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const gate = startStrictPriorityGate(
    'data-sync',
    {
      p0: { queue: dataSyncQueuesByTier.p0, worker: workersByTier(workers, activeTiers, 'p0') },
      p1: { queue: dataSyncQueuesByTier.p1, worker: workersByTier(workers, activeTiers, 'p1') },
      p2: { queue: dataSyncQueuesByTier.p2, worker: workersByTier(workers, activeTiers, 'p2') },
      p3: { queue: dataSyncQueuesByTier.p3, worker: workersByTier(workers, activeTiers, 'p3') },
    },
    { enabled: isDataSyncTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function workersByTier(
  workers: Worker<DataSyncJobData>[],
  activeTiers: readonly string[],
  tier: 'p0' | 'p1' | 'p2' | 'p3',
) {
  const index = activeTiers.indexOf(tier);
  if (index >= 0) {
    return workers[index];
  }
  return workers[0];
}
