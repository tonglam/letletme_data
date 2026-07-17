import {
  getEntrySyncQueue,
  type EntrySyncJobName,
  type EntrySyncJobSource,
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE,
  ENTRY_SYNC_DEFAULT_CONCURRENCY,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS,
} from '../queues/entry-sync.queue';
import { getEntrySyncJobPriority, type EntrySyncPriorityJobName } from '../domain/job-priority';
import { logError, logInfo } from '../utils/logger';
import { stableHash } from '../utils/stable-hash';

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
  runId?: string;
}

function hashEntryListKey(entryIds: readonly number[], eventId?: number): string {
  const sorted = [...entryIds].sort((a, b) => a - b).join(',');
  return stableHash(`${sorted}|e${eventId ?? ''}`);
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
    const tier = getEntrySyncJobPriority(jobName as EntrySyncPriorityJobName);
    const queue = getEntrySyncQueue(tier);
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
      runId: options.runId,
    };

    const chunkKey =
      options.eventId !== undefined ? `${chunkOffset}-event-${options.eventId}` : `${chunkOffset}`;
    // Entry-list jobs (manual/API HTTP triggers) get a deterministic content-based ID
    // so repeat triggers with the same payload dedupe in the waiting room. Cron chunk
    // jobs stay unique per cycle — static IDs would dedupe future cycles while
    // completed jobs are retained.
    const isEntryList = options.entryIds !== undefined;
    const defaultJobId = isEntryList
      ? `${jobName}-entry-list-${hashEntryListKey(options.entryIds ?? [], options.eventId)}`
      : `${jobName}-chunk-${chunkKey}-${Date.now()}`;
    const jobId = options.jobId ?? defaultJobId;

    const job = await queue.add(jobName, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60_000,
      },
      jobId,
      delay: options.delayMs,
      // See live-data.jobs.ts: deterministic IDs must not block re-triggers after
      // the previous run settles, so entry-list jobs clean up immediately.
      ...(isEntryList ? { removeOnComplete: true, removeOnFail: true } : {}),
    });

    logInfo('Entry sync job enqueued', {
      jobId: job.id,
      jobName,
      source,
      tier,
      queue: queue.name,
      chunkOffset,
      chunkSize,
    });
    return job;
  } catch (error) {
    const tier = getEntrySyncJobPriority(jobName as EntrySyncPriorityJobName);
    logError('Failed to enqueue entry sync job', error, { jobName, source, tier });
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
