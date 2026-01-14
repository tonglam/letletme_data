import { entrySyncQueue, type EntrySyncJobName } from '../queues/entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

export type EntrySyncJobSource = 'cron' | 'manual' | 'api';

export interface EntrySyncJobOptions {
  entryIds?: number[];
  retryCount?: number;
}

async function enqueueEntrySyncJob(
  jobName: EntrySyncJobName,
  source: EntrySyncJobSource = 'cron',
  options: EntrySyncJobOptions = {},
) {
  try {
    const job = await entrySyncQueue.add(
      jobName,
      {
        source,
        triggeredAt: new Date().toISOString(),
        entryIds: options.entryIds,
        retryCount: options.retryCount,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60_000,
        },
      },
    );

    logInfo('Entry sync job enqueued', { jobId: job.id, jobName, source });
    return job;
  } catch (error) {
    logError('Failed to enqueue entry sync job', error, { jobName, source });
    throw error;
  }
}

export const enqueueEntryInfoSyncJob = (
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-info', source, options);

export const enqueueEntryPicksSyncJob = (
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-picks', source, options);

export const enqueueEntryTransfersSyncJob = (
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-transfers', source, options);

export const enqueueEntryResultsSyncJob = (
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-results', source, options);
