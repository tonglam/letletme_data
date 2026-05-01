import { getDataSyncJobPriority, type DataSyncPriorityJobName } from '../domain/job-priority';
import { getDataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type DataSyncJobSource = 'cron' | 'manual' | 'api' | 'event-transition';

async function enqueueDataSyncJob(jobName: DataSyncJobName, source: DataSyncJobSource = 'cron') {
  try {
    const tier = getDataSyncJobPriority(jobName as DataSyncPriorityJobName);
    const queue = getDataSyncQueue(tier);
    const job = await queue.add(
      jobName,
      {
        source,
        triggeredAt: new Date().toISOString(),
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60_000,
        },
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

export const enqueueFixturesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('fixtures', source);

export const enqueueTeamsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('teams', source);

export const enqueuePlayersSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('players', source);

export const enqueuePlayerStatsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('player-stats', source);

export const enqueuePhasesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('phases', source);

export const enqueuePlayerValuesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('player-values', source);
