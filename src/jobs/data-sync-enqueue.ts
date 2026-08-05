import { getDataSyncJobPriority, type DataSyncPriorityJobName } from '../domain/job-priority';
import { getDataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';
import { formatCronDateKey } from '../utils/timezone';
import {
  createDataSyncJobData,
  defaultDataSyncJobId,
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
  jobName: DataSyncJobName,
  source: DataSyncJobSource = 'cron',
  options: DataSyncEnqueueOptions = {},
) {
  try {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    const queue = getDataSyncQueue(tier);
    const jobId = options.jobId ?? defaultDataSyncJobId(jobName, source, options);
    const hasDeterministicId = jobId !== undefined;
    const removeOnSettle = options.removeOnSettle ?? hasDeterministicId;
    const jobData = createDataSyncJobData(source, options);
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
      tier,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    logError('Failed to enqueue data sync job', error, { jobName, source, tier });
    throw error;
  }
}

export const enqueueCoreSnapshotJob = (
  source: DataSyncJobSource = 'cron',
  options?: DataSyncEnqueueOptions,
) =>
  enqueueDataSyncJob('core-snapshot', source, {
    ...options,
    jobId: getCoreSnapshotJobId(source, options),
    removeOnSettle: true,
  });

// Compatibility producers all converge on the one coherent core publisher.
export const enqueueEventsSyncJob = (source?: DataSyncJobSource) => enqueueCoreSnapshotJob(source);

export const enqueueFixturesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueCoreSnapshotJob(source, options);

/** The authoritative fixture endpoint already returns the complete season feed. */
export const enqueueFixturesAllGameweeksSyncJob = (source?: DataSyncJobSource) =>
  enqueueCoreSnapshotJob(source);

export const enqueueTeamsSyncJob = (source?: DataSyncJobSource) => enqueueCoreSnapshotJob(source);

export const enqueuePlayersSyncJob = (source?: DataSyncJobSource) => enqueueCoreSnapshotJob(source);

export const enqueuePlayerPricesSyncJob = (
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions & { changeDate: string },
) => enqueueDataSyncJob('player-prices', source, options);

export const enqueuePlayerStatsSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('player-stats', source, options);

export const enqueuePhasesSyncJob = (source?: DataSyncJobSource) => enqueueCoreSnapshotJob(source);

export const enqueuePlayerValuesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) =>
  enqueueDataSyncJob('player-values', source, {
    ...options,
    changeDate: options?.changeDate ?? formatCronDateKey(),
  });
