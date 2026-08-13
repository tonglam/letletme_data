import type { FplSeasonRef } from '../domain/fpl-season';
import { dataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';
import { formatCronDateKey } from '../utils/timezone';
import {
  createDataSyncJobData,
  defaultDataSyncJobId,
  getExplicitDataSyncQueueJobId,
  type DataSyncEnqueueOptions,
  type DataSyncJobSource,
} from './data-sync-job-definition';

export type { DataSyncEnqueueOptions, DataSyncJobSource } from './data-sync-job-definition';

export function getCoreSnapshotJobId(
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions = {},
): string | undefined {
  if (options.jobId) return options.jobId;
  if (source === 'cron') return `core-snapshot-${formatCronDateKey()}`;
  // An event transition must observe the event that caused the trigger. Keep
  // it distinct from an older repair job that may still be queued or active.
  if (source === 'event-transition') return undefined;
  return 'core-snapshot-repair';
}

async function enqueueDataSyncJob(
  season: FplSeasonRef,
  jobName: DataSyncJobName,
  source: DataSyncJobSource = 'cron',
  options: DataSyncEnqueueOptions = {},
) {
  try {
    const queue = dataSyncQueue;
    const jobId = options.jobId
      ? getExplicitDataSyncQueueJobId(season, options.jobId)
      : defaultDataSyncJobId(jobName, season, source, options);
    const hasDeterministicId = jobId !== undefined;
    const removeOnSettle = options.removeOnSettle ?? hasDeterministicId;
    const jobData = createDataSyncJobData(season, source, options);
    const job = await queue.add(jobName, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60_000,
      },
      jobId,
      ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
    });

    logInfo('Data sync job enqueued', {
      jobId: job.id,
      // BullMQ returns the existing job when a deterministic ID is already
      // queued. Log that stored correlation ID rather than the discarded
      // candidate so an operator can join a trigger to its attempt report.
      runId: job.data?.runId ?? jobData.runId,
      jobName,
      source,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue data sync job', error, { jobName, source });
    throw error;
  }
}

export const enqueueCoreSnapshotJob = (
  season: FplSeasonRef,
  source: DataSyncJobSource = 'cron',
  options?: DataSyncEnqueueOptions,
) =>
  enqueueDataSyncJob(season, 'core-snapshot', source, {
    ...options,
    jobId: getCoreSnapshotJobId(source, options),
    removeOnSettle: true,
  });

// Scoped producers converge on the one coherent core publisher.
export const enqueuePlayerPricesSyncJob = (
  season: FplSeasonRef,
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions & { changeDate: string },
) => enqueueDataSyncJob(season, 'player-prices', source, options);

export const enqueuePlayerStatsSyncJob = (
  season: FplSeasonRef,
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob(season, 'player-stats', source, options);

export const enqueuePlayerValuesSyncJob = (
  season: FplSeasonRef,
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) =>
  enqueueDataSyncJob(season, 'player-values', source, {
    ...options,
    changeDate: options?.changeDate ?? formatCronDateKey(),
  });
