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
import type { FplSeasonRef } from '../domain/fpl-season';
import { getCurrentEvent } from '../services/events.service';
import { logError, logInfo } from '../utils/logger';
import { stableHash } from '../utils/stable-hash';

export interface EntrySyncJobOptions {
  entryIds?: number[];
  retryCount?: number;
  chunkOffset?: number;
  afterEntryId?: number;
  resumeAfterEntryId?: number;
  chunkSize?: number;
  concurrency?: number;
  throttleMs?: number;
  jobId?: string;
  delayMs?: number;
  eventId?: number;
  runId?: string;
  /** Stable deduplication key for every table-scan chunk in one trigger lane. */
  queueKey?: string;
  removeOnSettle?: boolean;
}

export function retainEntrySyncChainOptions(
  options: Pick<EntrySyncJobOptions, 'runId' | 'queueKey' | 'removeOnSettle'> | undefined,
): Pick<EntrySyncJobOptions, 'runId' | 'queueKey' | 'removeOnSettle'> {
  return {
    runId: options?.runId,
    queueKey: options?.queueKey,
    removeOnSettle: options?.removeOnSettle,
  };
}

function hashEntryListKey(
  entryIds: readonly number[],
  eventId?: number,
  retryCount?: number,
  runId?: string,
): string {
  const sorted = [...entryIds].sort((a, b) => a - b).join(',');
  // Include retryCount so delayed full-batch retries do not collide with the
  // still-active original jobId (BullMQ dedupes identical jobIds). Internal
  // retries also include their scan identity so overlapping scans cannot
  // swallow one another's continuation.
  const retryScope = (retryCount ?? 0) > 0 ? `|run${runId ?? ''}` : '';
  return stableHash(`${sorted}|e${eventId ?? ''}|r${retryCount ?? 0}${retryScope}`);
}

function sanitizePositiveInt(value: number | undefined, fallback: number) {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

async function enqueueEntrySyncJob(
  jobName: EntrySyncJobName,
  season: FplSeasonRef,
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
      const hasEventScopedManualScan = pendingJobs.some(
        (job) =>
          job.name === jobName &&
          job.data.seasonId === season.seasonId &&
          job.data.source === 'manual' &&
          job.data.eventId !== undefined &&
          job.data.queueKey === 'manual',
      );
      // Results/picks/transfers roots historically omitted eventId and let the
      // worker resolve it. Once a continuation has resolved its target, an
      // unscoped root must resolve the same current event before deciding
      // whether it can be reused; otherwise a continuation from the previous
      // GW can suppress the new scan after the event advances.
      const resolvedManualEventId =
        options.eventId ??
        (jobName !== 'entry-info' && hasEventScopedManualScan
          ? (await getCurrentEvent(season))?.id
          : undefined);
      const existingManualScan = pendingJobs.find(
        (job) =>
          job.name === jobName &&
          job.data.seasonId === season.seasonId &&
          job.data.source === 'manual' &&
          // Manual scans are event-scoped when a target GW is supplied. An
          // unscoped root is resolved before this reuse check when a resolved
          // continuation is present, so it cannot reuse a prior GW's chain.
          (resolvedManualEventId === undefined
            ? job.data.eventId === undefined
            : job.data.eventId === resolvedManualEventId) &&
          job.data.queueKey === 'manual',
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
    const isEntryList = options.entryIds !== undefined;
    const removeOnSettle = options.removeOnSettle === true || isEntryList || source === 'manual';

    const jobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      source,
      triggeredAt: new Date().toISOString(),
      entryIds: options.entryIds,
      retryCount: options.retryCount,
      chunkOffset,
      afterEntryId: options.afterEntryId,
      resumeAfterEntryId: options.resumeAfterEntryId,
      chunkSize,
      concurrency,
      throttleMs,
      eventId: options.eventId,
      runId,
      queueKey: tableScanQueueKey,
      removeOnSettle,
    };

    const cursor = options.afterEntryId ?? chunkOffset;
    const chunkKey =
      options.eventId !== undefined ? `${cursor}-event-${options.eventId}` : `${cursor}`;
    // Entry-list jobs (API with explicit IDs) keep their content-based ID.
    // Table-scan chunks get deterministic IDs keyed by the trigger lane + offset
    // so correlation IDs can vary without forking parallel manual chains.
    const defaultJobId = isEntryList
      ? `${jobName}-${season.seasonCode}-entry-list-${hashEntryListKey(options.entryIds ?? [], options.eventId, options.retryCount, runId)}`
      : `${jobName}-${season.seasonCode}-${tableScanQueueKey}-chunk-${chunkKey}`;
    const jobId = options.jobId ?? defaultJobId;
    // Deterministic IDs must not block re-triggers after settle.
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
  season: FplSeasonRef,
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-info', season, source, options);

export const enqueueEntryPicksSyncJob = (
  season: FplSeasonRef,
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-picks', season, source, options);

export const enqueueEntryTransfersSyncJob = (
  season: FplSeasonRef,
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-transfers', season, source, options);

export const enqueueEntryResultsSyncJob = (
  season: FplSeasonRef,
  source?: EntrySyncJobSource,
  options?: EntrySyncJobOptions,
) => enqueueEntrySyncJob('entry-results', season, source, options);
