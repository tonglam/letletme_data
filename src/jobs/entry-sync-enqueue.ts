import { randomUUID } from 'crypto';

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
  /** Stable deduplication key for every table-scan chunk in one trigger lane. */
  queueKey?: string;
}

function hashEntryListKey(
  entryIds: readonly number[],
  eventId?: number,
  retryCount?: number,
): string {
  const sorted = [...entryIds].sort((a, b) => a - b).join(',');
  // Include retryCount so delayed full-batch retries do not collide with the
  // still-active original jobId (BullMQ dedupes identical jobIds).
  return stableHash(`${sorted}|e${eventId ?? ''}|r${retryCount ?? 0}`);
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

    const isManualScanRoot =
      source === 'manual' &&
      options.entryIds === undefined &&
      chunkOffset === 0 &&
      options.runId === undefined &&
      options.queueKey === undefined;
    if (isManualScanRoot) {
      const pendingJobs = await queue.getJobs(['waiting', 'delayed', 'active', 'paused']);
      const existingManualScan = pendingJobs.find(
        (job) =>
          job.name === jobName &&
          job.data.source === 'manual' &&
          // Manual scans are event-scoped when a target GW is supplied. An
          // unscoped root is resolved by the worker before it creates the
          // continuation chunks, so it must also reuse those resolved chunks
          // instead of starting a second full-table chain.
          (options.eventId === undefined || job.data.eventId === options.eventId) &&
          (job.data.queueKey === 'manual' ||
            (job.data.queueKey === undefined && job.data.runId === 'manual')),
      );
      if (existingManualScan) {
        logInfo('Entry sync manual scan already active; reusing existing', {
          jobId: existingManualScan.id,
          jobName,
          source,
          tier,
          queue: queue.name,
          runId: existingManualScan.data.runId,
        });
        return existingManualScan;
      }
    }

    // Stable runId for this chain. Retries and following chunks keep the same
    // runId. Every new manual scan gets a distinct correlation ID; its first
    // chunk still uses a separate stable queue key to dedupe concurrent triggers.
    const runId = options.runId ?? (source === 'cron' ? `${Date.now()}` : randomUUID());
    const tableScanQueueKey = options.queueKey ?? (source === 'manual' ? 'manual' : runId);

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
      runId,
      queueKey: tableScanQueueKey,
    };

    const chunkKey =
      options.eventId !== undefined ? `${chunkOffset}-event-${options.eventId}` : `${chunkOffset}`;
    // Entry-list jobs (API with explicit IDs) keep their content-based ID.
    // Table-scan chunks get deterministic IDs keyed by the trigger lane + offset
    // so correlation IDs can vary without forking parallel manual chains.
    const isEntryList = options.entryIds !== undefined;
    const defaultJobId = isEntryList
      ? `${jobName}-entry-list-${hashEntryListKey(options.entryIds ?? [], options.eventId, options.retryCount)}`
      : `${jobName}-${tableScanQueueKey}-chunk-${chunkKey}`;
    const jobId = options.jobId ?? defaultJobId;
    // Deterministic IDs must not block re-triggers after settle.
    const removeOnSettle = isEntryList || source === 'manual';

    const job = await queue.add(jobName, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60_000,
      },
      jobId,
      delay: options.delayMs,
      ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
    });

    logInfo('Entry sync job enqueued', {
      jobId: job.id,
      jobName,
      source,
      tier,
      queue: queue.name,
      chunkOffset,
      chunkSize,
      runId: job.data.runId ?? runId,
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
