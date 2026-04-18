import {
  entrySyncQueue,
  type EntrySyncJobName,
  type EntrySyncJobSource,
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE,
  ENTRY_SYNC_DEFAULT_CONCURRENCY,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS,
} from '../queues/entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

export interface EntrySyncJobOptions {
  entryIds?: number[];
  retryCount?: number;
  chunkOffset?: number;
  chunkSize?: number;
  concurrency?: number;
  throttleMs?: number;
  jobId?: string;
  delayMs?: number;
  eventId?: number;
}

function sanitizePositiveInt(value: number | undefined, fallback: number) {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

async function enqueueEntrySyncJob(
  jobName: EntrySyncJobName,
  source: EntrySyncJobSource = 'cron',
  options: EntrySyncJobOptions = {},
) {
  try {
    const chunkSize = sanitizePositiveInt(options.chunkSize, ENTRY_SYNC_DEFAULT_CHUNK_SIZE);
    const chunkOffset = Math.max(0, options.chunkOffset ?? 0);
    const concurrency = sanitizePositiveInt(options.concurrency, ENTRY_SYNC_DEFAULT_CONCURRENCY);
    const throttleMs = sanitizePositiveInt(options.throttleMs, ENTRY_SYNC_DEFAULT_THROTTLE_MS);

    const jobData = {
      source,
      triggeredAt: new Date().toISOString(),
      entryIds: options.entryIds,
      retryCount: options.retryCount,
      chunkOffset,
      chunkSize,
      concurrency,
      throttleMs,
      eventId: options.eventId,
    };

    const chunkKey =
      options.eventId !== undefined ? `${chunkOffset}:event:${options.eventId}` : `${chunkOffset}`;
    const dedupeJobId =
      options.jobId ?? (options.entryIds ? undefined : `${jobName}:chunk:${chunkKey}`);

    const job = await entrySyncQueue.add(jobName, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60_000,
      },
      jobId: dedupeJobId,
      delay: options.delayMs,
    });

    logInfo('Entry sync job enqueued', {
      jobId: job.id,
      jobName,
      source,
      chunkOffset,
      chunkSize,
    });
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
