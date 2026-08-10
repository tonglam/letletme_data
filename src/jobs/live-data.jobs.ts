import type { FplSeasonRef } from '../domain/fpl-season';
import { liveDataQueue, LIVE_JOBS, type LiveDataJobData } from '../queues/live-data.queue';
import { logError, logInfo } from '../utils/logger';

export type LiveDataJobSource = 'cron' | 'manual' | 'cascade';

async function hasSupersedingPendingJob(
  queue: typeof liveDataQueue,
  season: FplSeasonRef,
  eventId: number,
  persistEventLives: boolean,
): Promise<boolean> {
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.some(
      (job) =>
        job.name === LIVE_JOBS.LIVE_SNAPSHOT &&
        job.data.seasonId === season.seasonId &&
        job.data.eventId === eventId &&
        (!persistEventLives || job.data.persistEventLives === true),
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
  return date.toISOString().slice(0, 16).replace(/\D/g, '');
}

export async function enqueueLiveSnapshot(
  season: FplSeasonRef,
  eventId: number,
  source: LiveDataJobSource = 'cron',
  options: {
    persistEventLives?: boolean;
    finalizeEvent?: boolean;
    now?: Date;
    jobId?: string;
  } = {},
) {
  const persistEventLives = options.persistEventLives ?? false;
  const jobName = LIVE_JOBS.LIVE_SNAPSHOT;
  try {
    const queue = liveDataQueue;
    if (
      source === 'cron' &&
      (await hasSupersedingPendingJob(queue, season, eventId, persistEventLives))
    ) {
      logInfo('Live snapshot job already pending; skipping enqueue', {
        season: season.seasonCode,
        eventId,
        persistEventLives,
      });
      return null;
    }

    const jobData: LiveDataJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
      persistEventLives,
      ...(options.finalizeEvent !== undefined ? { finalizeEvent: options.finalizeEvent } : {}),
    };
    const suffix = persistEventLives ? 'persist' : 'cache';
    const generatedJobId =
      source === 'cron'
        ? `live-snapshot-${season.seasonCode}-e${eventId}-${liveSnapshotMinuteBucket(options.now ?? new Date())}-${suffix}`
        : `live-snapshot-${season.seasonCode}-e${eventId}-${source}-${suffix}`;
    const jobId = options.jobId ? `${season.seasonCode}-${options.jobId}` : generatedJobId;
    const job = await queue.add(jobName, jobData, {
      jobId,
      ...(source === 'manual' ? { removeOnComplete: true, removeOnFail: true } : {}),
    });
    logInfo('Live snapshot job enqueued', {
      jobId: job.id,
      season: season.seasonCode,
      eventId,
      source,
      persistEventLives,
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
