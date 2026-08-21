import { QueueEvents, Worker, type Job } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import { type DataSyncJobData, dataSyncQueue, dataSyncQueueName } from '../queues/data-sync.queue';
import { syncPlayerPricesForDate } from '../services/player-prices.service';
import { syncCurrentPlayerStats, syncPlayerStatsForEvent } from '../services/player-stats.service';
import { syncCurrentPlayerValues } from '../services/player-values.service';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import {
  resolveBullMqAttemptQueueWaitMs,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationScopes } from '../utils/mutation-scopes';
import { formatCronDateKey } from '../utils/timezone';
import type { WorkerRuntime } from './worker-runtime';

const processDataSyncJob = async (job: Job<DataSyncJobData>) => {
  const season = await requireCurrentSeasonForJob(job.data);
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
    const mutationInput = {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
    };

    // The player-values snapshot is the parent write for the price-sync job.
    // Commit it under the database scope before exposing the dependent job to
    // another worker; otherwise the child can read the previous snapshot.
    if (job.name === 'player-values') {
      return runTrackedJob(context, async () => {
        const changeDate = job.data.changeDate ?? formatCronDateKey(new Date(job.data.triggeredAt));
        const result = await withMutationScopes(mutationInput, () =>
          syncCurrentPlayerValues(season, changeDate, {
            onTargetEventResolved: recordResolvedTarget,
            deferPriceSyncEnqueue: true,
          }),
        );
        if (result.count > 0) {
          await enqueuePlayerPricesSyncJob(season, 'cascade', {
            changeDate,
            jobId: `player-prices-${changeDate}-immediate`,
            removeOnSettle: true,
          });
        }
        return result;
      });
    }

    const execute = () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case 'core-snapshot':
            return syncCoreSnapshot(season);
          case 'player-prices':
            if (!job.data.changeDate) {
              throw new Error('player-prices job requires changeDate');
            }
            return syncPlayerPricesForDate(season, job.data.changeDate);
          case 'player-stats':
            return job.data.eventId !== undefined
              ? syncPlayerStatsForEvent(season, job.data.eventId)
              : syncCurrentPlayerStats(season, { onTargetEventResolved: recordResolvedTarget });
          case 'player-values':
            return syncCurrentPlayerValues(
              season,
              job.data.changeDate ?? formatCronDateKey(new Date(job.data.triggeredAt)),
              { onTargetEventResolved: recordResolvedTarget },
            );
          default:
            throw new Error(`Unknown data-sync job: ${job.name}`);
        }
      });

    // Core aliases perform upstream reads before acquiring their own short
    // multi-table persistence/publication lock.
    if (job.name === 'core-snapshot') return execute();
    return withMutationScopes(mutationInput, execute);
  });
};

export function createDataSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<DataSyncJobData>(dataSyncQueueName, processDataSyncJob, {
    connection,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(dataSyncQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Data sync job completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', (job, error) => {
    logError('Data sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) void alertOnFinalFailure(job, error);
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: dataSyncQueue, queueEvents, queueName: dataSyncQueueName }],
  };
}
