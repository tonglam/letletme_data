import { randomUUID } from 'node:crypto';
import type { FplSeasonRef } from '../domain/fpl-season';
import { liveDataQueue, LIVE_JOBS, type LiveDataJobData } from '../queues/live-data.queue';
import { logError, logInfo } from '../utils/logger';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';
import type { MatchLifecycleState } from '../services/live-match-v2';
import {
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchCheckpointLastAtV2,
} from '../cache/live-match-publication-v2';

const LIVE_MATCH_CHECKPOINT_INTERVAL_MS = 10 * 60_000;

export type LiveDataJobSource = 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';

async function hasSupersedingPendingJob(
  queue: typeof liveDataQueue,
  season: FplSeasonRef,
  eventId: number,
  finalizeEvent: boolean,
): Promise<boolean> {
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.some(
      (job) =>
        job.name === LIVE_JOBS.LIVE_SNAPSHOT &&
        job.data.seasonId === season.seasonId &&
        job.data.eventId === eventId &&
        (finalizeEvent ? job.data.finalizeEvent === true : job.data.finalizeEvent !== true),
    );
  } catch (error) {
    logError('Failed to check pending live-data jobs', error, {
      season: season.seasonCode,
      eventId,
    });
    return false;
  }
}

export function liveSnapshotMinuteBucket(date: Date): string {
  const seconds = Math.floor(date.getUTCSeconds() / 30) * 30;
  return `${date.toISOString().slice(0, 16).replace(/\D/g, '')}${String(seconds).padStart(2, '0')}`;
}

export async function enqueueLiveActiveSnapshot(
  season: FplSeasonRef,
  eventId: number,
  now: Date,
  lifecycleState: MatchLifecycleState = 'LIVE_ACTIVE',
  expectedNextCheckAt: Date | string | null = null,
) {
  // V2 publishes every valid source change to Redis. PostgreSQL checkpointing
  // is decided by the publication service (first/boundary/final or at most
  // once per ten minutes), so the scheduler must not manufacture a second
  // periodic write lane.
  return enqueueLiveSnapshot(season, eventId, 'cron', {
    now,
    lifecycleState,
    expectedNextCheckAt,
  });
}

/**
 * Enqueue one coalesced Redis-first Match checkpoint obligation. A retained
 * completed/failed Bull record is never treated as evidence for a new desired
 * publication; it receives a bounded retry id while the Redis marker remains
 * the source of truth.
 */
export async function enqueueLiveMatchCheckpoint(
  season: FplSeasonRef,
  eventId: number,
  kind: 'desk' | 'detail',
  publicationId: string,
  generation: number,
  options: { readonly successor?: boolean; readonly delayMs?: number } = {},
) {
  try {
    const queue = liveDataQueue;
    if (await isQueueDrainOnly(queue.name)) {
      throw new QueueDrainOnlyError(queue.name);
    }
    const baseJobId = `live-match-checkpoint-${season.seasonCode}-e${eventId}-${kind}-v2`;
    const pending = await queue.getJobs(
      options.successor
        ? ['waiting', 'delayed', 'paused']
        : ['waiting', 'delayed', 'active', 'paused'],
    );
    const existingPending = pending.find(
      (job) =>
        job.name === LIVE_JOBS.LIVE_MATCH_CHECKPOINT &&
        job.data.seasonId === season.seasonId &&
        job.data.eventId === eventId &&
        job.data.checkpointKind === kind,
    );
    if (existingPending) {
      logInfo('Live Match checkpoint scope already pending; coalescing desired publication', {
        jobId: existingPending.id,
        season: season.seasonCode,
        eventId,
        kind,
        generation,
      });
      return existingPending;
    }
    const existing = options.successor ? null : await queue.getJob(baseJobId);
    let jobId = options.successor ? `${baseJobId}-successor-${randomUUID()}` : baseJobId;
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'waiting-children', 'delayed', 'active', 'paused'].includes(state)) {
        logInfo('Live Match checkpoint job already pending; coalescing desired publication', {
          jobId: existing.id,
          season: season.seasonCode,
          eventId,
          kind,
          generation,
        });
        return existing;
      }
      // A retained terminal record cannot provide a future completion event
      // for the newer Redis desired marker. Keep the evidence and use a
      // bounded retry ID; the marker remains the source of truth.
      jobId = `${baseJobId}-retry-${randomUUID()}`;
    }
    const job = await queue.add(
      LIVE_JOBS.LIVE_MATCH_CHECKPOINT,
      {
        seasonId: season.seasonId,
        seasonCode: season.seasonCode,
        eventId,
        source: 'reconcile',
        triggeredAt: new Date().toISOString(),
        checkpointKind: kind,
        checkpointPublicationId: publicationId,
        checkpointGeneration: generation,
      } satisfies LiveDataJobData,
      {
        jobId,
        ...(options.delayMs && options.delayMs > 0 ? { delay: Math.ceil(options.delayMs) } : {}),
      },
    );
    logInfo('Live Match checkpoint job enqueued', {
      jobId: job.id,
      season: season.seasonCode,
      eventId,
      kind,
      generation,
      queue: queue.name,
    });
    return job;
  } catch (error) {
    logError('Failed to enqueue Live Match checkpoint job', error, {
      season: season.seasonCode,
      eventId,
      kind,
      generation,
    });
    throw error;
  }
}

/**
 * Re-enqueue the desired marker after the active checkpoint job reaches its
 * batch boundary. This closes both the active-job coalescing race and the
 * non-final ten-minute delay without touching FPL or PostgreSQL.
 */
export async function enqueueRemainingLiveMatchCheckpoint(
  season: FplSeasonRef,
  eventId: number,
  kind: 'desk' | 'detail',
) {
  const desired = await readLiveMatchCheckpointDesiredV2({
    season: season.seasonCode,
    eventId,
    kind,
  });
  if (!desired) return null;
  let delayMs = 0;
  if (!desired.final && !desired.force) {
    const lastAt = await readLiveMatchCheckpointLastAtV2({
      season: season.seasonCode,
      eventId,
      kind,
    });
    const lastMs = lastAt === null ? Number.NaN : Date.parse(lastAt);
    if (Number.isFinite(lastMs)) {
      delayMs = Math.max(0, lastMs + LIVE_MATCH_CHECKPOINT_INTERVAL_MS - Date.now());
    }
  }
  return enqueueLiveMatchCheckpoint(
    season,
    eventId,
    kind,
    desired.publicationId,
    desired.generation,
    { successor: true, delayMs },
  );
}

export async function enqueueLiveSnapshot(
  season: FplSeasonRef,
  eventId: number,
  source: LiveDataJobSource = 'cron',
  options: {
    finalizeEvent?: boolean;
    now?: Date;
    jobId?: string;
    runId?: string;
    obligationId?: string;
    obligationGeneration?: number;
    freshnessWindowId?: number;
    /** Scheduler reconciliation may join an already-enqueued deterministic job. */
    reuseExisting?: boolean;
    lifecycleState?: MatchLifecycleState;
    /** Deadline of the scheduler observation that produced this job. */
    expectedNextCheckAt?: Date | string | null;
  } = {},
) {
  const jobName = LIVE_JOBS.LIVE_SNAPSHOT;
  try {
    const queue = liveDataQueue;
    if (await isQueueDrainOnly(queue.name)) {
      throw new QueueDrainOnlyError(queue.name);
    }
    const explicitJobId = options.jobId ? `${season.seasonCode}-${options.jobId}` : null;
    let replacementJobId: string | null = null;
    const existingExplicitJob = explicitJobId ? await queue.getJob(explicitJobId) : null;
    if (existingExplicitJob) {
      if (!options.reuseExisting) {
        logInfo('Live snapshot job already exists; skipping enqueue', {
          jobId: explicitJobId,
          season: season.seasonCode,
          eventId,
        });
        return null;
      }
      const state = await existingExplicitJob.getState();
      const activeStates = ['waiting', 'waiting-children', 'delayed', 'active', 'paused'];
      if (options.reuseExisting && !activeStates.includes(state)) {
        // A retained completed/failed record cannot provide a future worker
        // completion event for a newly reclaimed scheduler lease. Keep that
        // evidence and use a one-off retry ID; scheduler generations normally
        // already provide a fresh deterministic ID, while this fallback also
        // covers an enqueue-success/DB-confirmation-loss race.
        replacementJobId = `${explicitJobId}-retry-${randomUUID()}`;
      } else if (activeStates.includes(state)) {
        logInfo('Live snapshot job already exists; skipping enqueue', {
          jobId: explicitJobId,
          season: season.seasonCode,
          eventId,
          state,
        });
        return options.reuseExisting ? existingExplicitJob : null;
      }
    }
    if (
      source === 'cron' &&
      (await hasSupersedingPendingJob(queue, season, eventId, options.finalizeEvent === true))
    ) {
      logInfo('Live snapshot job already pending; skipping enqueue', {
        season: season.seasonCode,
        eventId,
      });
      return null;
    }

    const jobData: LiveDataJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
      // The first scheduler generation uses the obligation as its evidence
      // join key. A failed generation must receive a fresh sync-run identity;
      // otherwise a retry would reuse the terminal failed run and be unable to
      // activate its publication. Bull retries within one generation keep the
      // same runId, while a new generation is fenced by a new UUID.
      runId:
        options.runId ??
        (options.obligationId && (options.obligationGeneration ?? 0) === 0
          ? options.obligationId
          : randomUUID()),
      ...(options.obligationId ? { obligationId: options.obligationId } : {}),
      ...(options.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: options.obligationGeneration }),
      ...(options.freshnessWindowId === undefined
        ? {}
        : { freshnessWindowId: options.freshnessWindowId }),
      ...(options.finalizeEvent !== undefined ? { finalizeEvent: options.finalizeEvent } : {}),
      ...(options.lifecycleState !== undefined ? { lifecycleState: options.lifecycleState } : {}),
      ...(options.expectedNextCheckAt === undefined
        ? {}
        : {
            expectedNextCheckAt:
              options.expectedNextCheckAt === null
                ? null
                : new Date(options.expectedNextCheckAt).toISOString(),
          }),
    };
    const suffix = 'v2';
    const generatedJobId =
      source === 'cron'
        ? `live-snapshot-${season.seasonCode}-e${eventId}-${liveSnapshotMinuteBucket(options.now ?? new Date())}-${suffix}`
        : `live-snapshot-${season.seasonCode}-e${eventId}-${source}-${suffix}`;
    const jobId = replacementJobId ?? explicitJobId ?? generatedJobId;
    const job = await queue.add(jobName, jobData, {
      jobId,
      ...(source === 'manual' ? { removeOnComplete: true, removeOnFail: true } : {}),
    });
    logInfo('Live snapshot job enqueued', {
      jobId: job.id,
      season: season.seasonCode,
      eventId,
      source,
      queue: queue.name,
    });
    return job;
  } catch (error) {
    logError('Failed to enqueue live snapshot job', error, {
      season: season.seasonCode,
      eventId,
      source,
    });
    throw error;
  }
}
