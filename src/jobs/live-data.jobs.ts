import type { FplSeasonRef } from '../domain/fpl-season';
import { liveDataQueue, LIVE_JOBS, type LiveDataJobData } from '../queues/live-data.queue';
import { logError, logInfo } from '../utils/logger';

export type LiveDataJobSource = 'cron' | 'manual' | 'cascade';

const LIVE_SNAPSHOT_PERSISTENCE_BUCKET_MS = 10 * 60_000;

async function hasSupersedingPendingJob(
  queue: typeof liveDataQueue,
  season: FplSeasonRef,
  eventId: number,
  persistEventLives: boolean,
  finalizeEvent: boolean,
): Promise<boolean> {
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.some(
      (job) =>
        job.name === LIVE_JOBS.LIVE_SNAPSHOT &&
        job.data.seasonId === season.seasonId &&
        job.data.eventId === eventId &&
        (finalizeEvent
          ? job.data.finalizeEvent === true
          : !persistEventLives || job.data.persistEventLives === true),
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

export function liveSnapshotPersistenceJobId(eventId: number, date: Date): string {
  const bucketStart = new Date(
    Math.floor(date.getTime() / LIVE_SNAPSHOT_PERSISTENCE_BUCKET_MS) *
      LIVE_SNAPSHOT_PERSISTENCE_BUCKET_MS,
  );
  return `live-snapshot-e${eventId}-periodic-${bucketStart
    .toISOString()
    .slice(0, 16)
    .replace(/\D/g, '')}`;
}

export async function enqueueLiveActiveSnapshot(season: FplSeasonRef, eventId: number, now: Date) {
  const periodicJobId = liveSnapshotPersistenceJobId(eventId, now);
  const qualifiedPeriodicJobId = `${season.seasonCode}-${periodicJobId}`;
  const periodicSnapshotExists = Boolean(await liveDataQueue.getJob(qualifiedPeriodicJobId));

  return enqueueLiveSnapshot(season, eventId, 'cron', {
    now,
    persistEventLives: !periodicSnapshotExists,
    ...(periodicSnapshotExists ? {} : { jobId: periodicJobId }),
  });
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
    const explicitJobId = options.jobId ? `${season.seasonCode}-${options.jobId}` : null;
    if (explicitJobId && (await queue.getJob(explicitJobId))) {
      logInfo('Live snapshot job already exists; skipping enqueue', {
        jobId: explicitJobId,
        season: season.seasonCode,
        eventId,
        persistEventLives,
      });
      return null;
    }
    if (
      source === 'cron' &&
      (await hasSupersedingPendingJob(
        queue,
        season,
        eventId,
        persistEventLives,
        options.finalizeEvent === true,
      ))
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
    const jobId = explicitJobId ?? generatedJobId;
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
