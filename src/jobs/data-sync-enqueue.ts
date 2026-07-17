import { getDataSyncJobPriority, type DataSyncPriorityJobName } from '../domain/job-priority';
import { getDataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type DataSyncJobSource = 'cron' | 'manual' | 'api' | 'event-transition';

interface DataSyncEnqueueOptions {
  jobId?: string;
  eventId?: number;
  /** When true (default for explicit jobId), remove job on settle so re-triggers work. */
  removeOnSettle?: boolean;
}

async function enqueueDataSyncJob(
  jobName: DataSyncJobName,
  source: DataSyncJobSource = 'cron',
  options: DataSyncEnqueueOptions = {},
) {
  try {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    const queue = getDataSyncQueue(tier);
    const hasDeterministicId = options.jobId !== undefined;
    const removeOnSettle = options.removeOnSettle ?? hasDeterministicId;
    const job = await queue.add(
      jobName,
      {
        source,
        triggeredAt: new Date().toISOString(),
        ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60_000,
        },
        jobId: options.jobId,
        ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
      },
    );

    logInfo('Data sync job enqueued', {
      jobId: job.id,
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

export const enqueueEventsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('events', source);

export const enqueueFixturesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('fixtures', source, options);

export const enqueueTeamsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('teams', source);

export const enqueuePlayersSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('players', source);

export const enqueuePlayerStatsSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('player-stats', source, options);

export const enqueuePhasesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('phases', source);

export const enqueuePlayerValuesSyncJob = (
  source?: DataSyncJobSource,
  options?: DataSyncEnqueueOptions,
) => enqueueDataSyncJob('player-values', source, options);
