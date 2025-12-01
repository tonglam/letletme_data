import { dataSyncQueue, type DataSyncJobName } from '../queues/data-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type DataSyncJobSource = 'cron' | 'manual' | 'api';

async function enqueueDataSyncJob(jobName: DataSyncJobName, source: DataSyncJobSource = 'cron') {
  try {
    const job = await dataSyncQueue.add(
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
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue data sync job', error, { jobName, source });
    throw error;
  }
}

export const enqueueEventsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('events', source);

export const enqueueTeamsSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('teams', source);

export const enqueuePlayersSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('players', source);

export const enqueuePhasesSyncJob = (source?: DataSyncJobSource) =>
  enqueueDataSyncJob('phases', source);
