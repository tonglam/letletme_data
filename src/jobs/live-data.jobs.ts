import { randomUUID } from 'node:crypto';
import type { FplSeasonRef } from '../domain/fpl-season';
import { liveDataQueue, LIVE_JOBS, type LiveDataJobData } from '../queues/live-data.queue';
import { logError, logInfo } from '../utils/logger';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

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

export async function enqueueLiveActiveSnapshot(season: FplSeasonRef, eventId: number, now: Date) {
  // V2 publishes every valid source change to Redis. PostgreSQL checkpointing
  // is decided by the publication service (first/boundary/final or at most
  // once per ten minutes), so the scheduler must not manufacture a second
  // periodic write lane.
  return enqueueLiveSnapshot(season, eventId, 'cron', { now });
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
