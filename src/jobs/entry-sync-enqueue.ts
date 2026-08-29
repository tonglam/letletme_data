import { randomUUID } from 'crypto';
import type { Job } from 'bullmq';

import {
  entrySyncQueue,
  type EntrySyncJobData,
  type EntrySyncLane,
  type EntrySyncJobName,
  type EntrySyncJobSource,
  ENTRY_SYNC_DEFAULT_CHUNK_SIZE,
  ENTRY_SYNC_DEFAULT_CONCURRENCY,
  ENTRY_SYNC_DEFAULT_THROTTLE_MS,
} from '../queues/entry-sync.queue';
import { livePicksQueue } from '../queues/live-picks.queue';
import type { FplSeasonRef } from '../domain/fpl-season';
import { getCurrentEvent } from '../services/events.service';
import { logError, logInfo } from '../utils/logger';
import { stableHash } from '../utils/stable-hash';
import { trackQueueRunJob } from '../services/queue-run-tracker';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export interface EntrySyncJobOptions {
  entryIds?: number[];
  retryCount?: number;
  afterEntryId?: number;
  resumeAfterEntryId?: number;
  chunkSize?: number;
  concurrency?: number;
  throttleMs?: number;
  jobId?: string;
  delayMs?: number;
  eventId?: number;
  runId?: string;
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired, inherited by retries/continuations. */
  freshnessWindowId?: number;
  /** Stable source checkpoint shared by a post-match pipeline. */
  freshAfter?: string;
  /** Stable deduplication key for every table-scan chunk in one trigger lane. */
  queueKey?: string;
  /** Optional Redis-backed deduplication identity that survives process restarts. */
  deduplicationId?: string;
  /** Minimum interval between accepted jobs after the active single-flight settles. */
  deduplicationCadenceMs?: number;
  removeOnSettle?: boolean;
  lane?: EntrySyncLane;
}

export function retainEntrySyncChainOptions(
  options:
    | Pick<
        EntrySyncJobOptions,
        | 'runId'
        | 'queueKey'
        | 'removeOnSettle'
        | 'obligationId'
        | 'obligationGeneration'
        | 'freshnessWindowId'
        | 'freshAfter'
        | 'lane'
      >
    | undefined,
): Pick<
  EntrySyncJobOptions,
  | 'runId'
  | 'queueKey'
  | 'removeOnSettle'
  | 'obligationId'
  | 'obligationGeneration'
  | 'freshnessWindowId'
  | 'freshAfter'
  | 'lane'
> {
  return {
    runId: options?.runId,
    obligationId: options?.obligationId,
    obligationGeneration: options?.obligationGeneration,
    freshnessWindowId: options?.freshnessWindowId,
    queueKey: options?.queueKey,
    removeOnSettle: options?.removeOnSettle,
    freshAfter: options?.freshAfter,
    lane: options?.lane,
  };
}

export function entryQueueForLane(lane: EntrySyncLane | undefined) {
  // Live Points is a hard cut: the provider lane is always isolated from the
  // generic entry-sync queue.  A rollout flag must never silently route live
  // picks back to the old worker, because that recreates the mixed-version
  // publication path this lane is designed to remove.
  return lane === 'live-picks' ? livePicksQueue : entrySyncQueue;
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

function hashEntryListContentKey(entryIds: readonly number[], eventId?: number): string {
  const sorted = [...entryIds].sort((a, b) => a - b).join(',');
  return stableHash(`${sorted}|e${eventId ?? ''}`);
}

function sanitizePositiveInt(value: number | undefined, fallback: number) {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function sanitizeCursor(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

const RECENT_COMPLETED_DEDUPLICATION_SCAN_LIMIT = 500;

function matchesExplicitDeduplicationScope(
  job: Job<EntrySyncJobData>,
  input: {
    jobName: EntrySyncJobName;
    season: FplSeasonRef;
    source: EntrySyncJobSource;
    eventId: number | undefined;
    queueKey: string;
    deduplicationId: string;
  },
): boolean {
  if (
    job.name !== input.jobName ||
    job.data.seasonId !== input.season.seasonId ||
    job.data.source !== input.source ||
    job.data.eventId !== input.eventId
  ) {
    return false;
  }
  if (job.data.deduplicationId === input.deduplicationId) return true;
  // Jobs created before the single-flight migration do not carry the durable
  // identity in their payload. Their event-scoped queue key is the safe bridge.
  return job.data.deduplicationId === undefined && job.data.queueKey === input.queueKey;
}

async function findReusableExplicitDeduplicationJob(
  input: Parameters<typeof matchesExplicitDeduplicationScope>[1] & {
    cadenceMs: number;
    queue: typeof entrySyncQueue;
  },
): Promise<{ job: Job<EntrySyncJobData>; reason: 'non-terminal' | 'cadence' } | null> {
  const nonTerminalJobs = await input.queue.getJobs(['waiting', 'delayed', 'active', 'paused']);
  const nonTerminal = nonTerminalJobs.find((job) => matchesExplicitDeduplicationScope(job, input));
  if (nonTerminal) return { job: nonTerminal, reason: 'non-terminal' };

  const completedJobs = await input.queue.getJobs(
    ['completed'],
    0,
    RECENT_COMPLETED_DEDUPLICATION_SCAN_LIMIT - 1,
    false,
  );
  const nowMs = Date.now();
  const recentCompleted = completedJobs
    .filter((job) => matchesExplicitDeduplicationScope(job, input))
    .map((job) => ({ job, triggeredAt: Date.parse(job.data.triggeredAt) }))
    .filter(
      ({ triggeredAt }) =>
        Number.isFinite(triggeredAt) &&
        triggeredAt <= nowMs &&
        nowMs - triggeredAt < input.cadenceMs,
    )
    .sort((a, b) => b.triggeredAt - a.triggeredAt)[0]?.job;
  return recentCompleted ? { job: recentCompleted, reason: 'cadence' } : null;
}

async function enqueueEntrySyncJob(
  jobName: EntrySyncJobName,
  season: FplSeasonRef,
  source: EntrySyncJobSource = 'cron',
  options: EntrySyncJobOptions = {},
) {
  try {
    const lane = options.lane ?? 'entry-sync';
    const queue = entryQueueForLane(lane);
    if (await isQueueDrainOnly(queue.name)) {
      throw new QueueDrainOnlyError(queue.name);
    }
    const chunkSize = sanitizePositiveInt(options.chunkSize, ENTRY_SYNC_DEFAULT_CHUNK_SIZE);
    const afterEntryId = sanitizeCursor(options.afterEntryId);
    const concurrency = sanitizePositiveInt(options.concurrency, ENTRY_SYNC_DEFAULT_CONCURRENCY);
    const throttleMs = sanitizePositiveInt(options.throttleMs, ENTRY_SYNC_DEFAULT_THROTTLE_MS);

    const isManualScanRoot =
      source === 'manual' &&
      options.entryIds === undefined &&
      afterEntryId === 0 &&
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
    const lifecycleDedupeEntryList =
      source === 'api' &&
      isEntryList &&
      (options.retryCount ?? 0) === 0 &&
      options.jobId === undefined;
    const explicitDeduplicationId = options.deduplicationId?.trim();
    const explicitDeduplicationCadenceMs = options.deduplicationCadenceMs;
    if (
      explicitDeduplicationId === '' ||
      (explicitDeduplicationId === undefined && explicitDeduplicationCadenceMs !== undefined) ||
      (explicitDeduplicationCadenceMs !== undefined &&
        (!Number.isFinite(explicitDeduplicationCadenceMs) || explicitDeduplicationCadenceMs < 1))
    ) {
      throw new Error(
        'Entry sync deduplication requires a non-empty id; cadence is optional for active-only single-flight',
      );
    }
    if (explicitDeduplicationId && explicitDeduplicationCadenceMs) {
      const reusable = await findReusableExplicitDeduplicationJob({
        jobName,
        season,
        source,
        eventId: options.eventId,
        queueKey: tableScanQueueKey,
        deduplicationId: explicitDeduplicationId,
        cadenceMs: explicitDeduplicationCadenceMs,
        queue,
      });
      if (reusable) {
        logInfo('Entry sync explicit deduplication reused existing job', {
          jobId: reusable.job.id,
          jobName,
          source,
          queue: queue.name,
          runId: reusable.job.data.runId,
          reason: reusable.reason,
        });
        await trackQueueRunJob(reusable.job.data.runId ?? runId, queue.name, reusable.job.id);
        return reusable.job;
      }
    }
    // Keep queue evidence for every non-manual trigger, including explicit
    // entry-list/API scans. Manual one-shots may still clean up on settle.
    const removeOnSettle = source === 'manual' && options.removeOnSettle !== false;

    const jobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      source,
      lane,
      triggeredAt: new Date().toISOString(),
      entryIds: options.entryIds,
      retryCount: options.retryCount,
      afterEntryId,
      resumeAfterEntryId: options.resumeAfterEntryId,
      chunkSize,
      concurrency,
      throttleMs,
      eventId: options.eventId,
      runId,
      obligationId: options.obligationId,
      obligationGeneration: options.obligationGeneration,
      freshnessWindowId: options.freshnessWindowId,
      freshAfter: options.freshAfter,
      queueKey: tableScanQueueKey,
      deduplicationId: explicitDeduplicationId,
      removeOnSettle,
    };

    const chunkKey =
      options.eventId !== undefined
        ? `${afterEntryId}-event-${options.eventId}`
        : `${afterEntryId}`;
    const entryListContentKey = hashEntryListContentKey(options.entryIds ?? [], options.eventId);
    // Explicit API entry lists use BullMQ's lifecycle deduplication key while
    // keeping a unique job record for every terminal re-trigger. Internal
    // retries and coordinator-owned jobs retain their run-scoped IDs.
    const defaultJobId = lifecycleDedupeEntryList
      ? `${jobName}-${season.seasonCode}-entry-list-${entryListContentKey}-run-${randomUUID()}`
      : isEntryList
        ? `${jobName}-${season.seasonCode}-entry-list-${hashEntryListKey(options.entryIds ?? [], options.eventId, options.retryCount, runId)}`
        : `${jobName}-${season.seasonCode}-${tableScanQueueKey}-chunk-${chunkKey}`;
    const jobId = options.jobId ?? defaultJobId;
    // Deterministic IDs must not block re-triggers after settle.
    const addedJob = await queue.add(jobName, jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60_000,
      },
      jobId,
      delay: options.delayMs,
      ...(explicitDeduplicationId
        ? {
            deduplication: {
              id: explicitDeduplicationId,
            },
          }
        : lifecycleDedupeEntryList
          ? {
              deduplication: {
                id: `${jobName}-${season.seasonCode}-entry-list-${entryListContentKey}`,
              },
            }
          : {}),
      ...(removeOnSettle ? { removeOnComplete: true, removeOnFail: true } : {}),
    });

    // BullMQ may return a Job carrying the newly submitted data when an add is
    // deduplicated, even though its ID points at an older persisted job. Any
    // caller deriving claims from deduplication must see the Redis payload.
    const usesRedisDeduplication = Boolean(explicitDeduplicationId) || lifecycleDedupeEntryList;
    const job = usesRedisDeduplication
      ? addedJob.id
        ? await queue.getJob(addedJob.id)
        : null
      : addedJob;
    if (!job) {
      throw new Error('Entry sync deduplicated job could not be loaded from Redis');
    }

    logInfo('Entry sync job enqueued', {
      jobId: job.id,
      jobName,
      source,
      queue: queue.name,
      afterEntryId,
      chunkSize,
      runId: job.data.runId ?? runId,
    });
    await trackQueueRunJob(job.data.runId ?? runId, queue.name, job.id);
    return job;
  } catch (error) {
    logError('Failed to enqueue entry sync job', error, { jobName, source });
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
