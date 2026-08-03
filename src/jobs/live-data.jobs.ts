import {
  getLiveDataQueue,
  LIVE_JOBS,
  type LiveDataJobName,
  type LiveDataJobData,
} from '../queues/live-data.queue';
import { getLiveDataJobPriority, type LiveDataPriorityJobName } from '../domain/job-priority';
import { logError, logInfo } from '../utils/logger';

export type LiveDataJobSource = 'cron' | 'manual' | 'cascade';

async function hasPendingJob(
  queue: ReturnType<typeof getLiveDataQueue>,
  jobName: LiveDataJobName,
  eventId: number,
): Promise<boolean> {
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.some((job) => job.name === jobName && job.data.eventId === eventId);
  } catch (error) {
    logError('Failed to check pending live-data jobs', error, { jobName, eventId });
    // If we can't tell, allow enqueue (safer than dropping a tick).
    return false;
  }
}

async function enqueueLiveDataJob(
  jobName: LiveDataJobName,
  eventId: number,
  source: LiveDataJobSource = 'cron',
  options: { delay?: number; jobId?: string; persistEventLives?: boolean } = {},
) {
  try {
    const tier = getLiveDataJobPriority(jobName as LiveDataPriorityJobName);
    const queue = getLiveDataQueue(tier);

    // Skip duplicate pending work so a slow minute cannot stack behind itself.
    // This applies even when the scheduler supplies a deterministic minute ID:
    // the next minute has a different ID while the previous job may still run.
    if (source === 'cron' && (await hasPendingJob(queue, jobName, eventId))) {
      logInfo('Live data job already pending; skipping enqueue', { jobName, eventId, source });
      return null;
    }

    const jobData: LiveDataJobData = {
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
      ...(options.persistEventLives !== undefined
        ? { persistEventLives: options.persistEventLives }
        : {}),
    };

    // Manual triggers share a deterministic ID per (job, event) so repeat triggers
    // dedupe while the job waits in the queue. Cron/cascade runs stay unique per
    // tick — static IDs would dedupe and block subsequent runs while completed
    // jobs are retained.
    const isManual = source === 'manual';
    const defaultJobId = isManual
      ? `${jobName}-e${eventId}-manual`
      : `${jobName}-e${eventId}-${Date.now()}`;

    const job = await queue.add(jobName, jobData, {
      jobId: options.jobId ?? defaultJobId,
      delay: options.delay,
      // Deterministic IDs dedupe across retained jobs too — without immediate
      // cleanup a settled manual job would silently swallow every later re-trigger
      // for the rest of the retention window. Run history lives in the job-run log.
      ...(isManual ? { removeOnComplete: true, removeOnFail: true } : {}),
    });

    logInfo('Live data job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      source,
      tier,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    const tier = getLiveDataJobPriority(jobName as LiveDataPriorityJobName);
    logError('Failed to enqueue live data job', error, { jobName, eventId, source, tier });
    throw error;
  }
}

export function liveSnapshotMinuteBucket(date: Date): string {
  return date.toISOString().slice(0, 16).replace(/\D/g, '');
}

export const enqueueLiveSnapshot = (
  eventId: number,
  source: LiveDataJobSource = 'cron',
  options: { persistEventLives?: boolean; now?: Date; jobId?: string } = {},
) =>
  enqueueLiveDataJob(LIVE_JOBS.LIVE_SNAPSHOT, eventId, source, {
    persistEventLives: options.persistEventLives ?? false,
    jobId:
      options.jobId ??
      (source === 'cron'
        ? `live-snapshot-e${eventId}-${liveSnapshotMinuteBucket(options.now ?? new Date())}`
        : undefined),
  });

export const enqueueEventLivesCacheUpdate = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVES_CACHE, eventId, source);

export const enqueueEventLivesDbSync = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVES_DB, eventId, source);

export const enqueueEventLiveSummary = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVE_SUMMARY, eventId, source);

export const enqueueEventLiveExplain = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVE_EXPLAIN, eventId, source);

export const enqueueLiveFixtureCache = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.LIVE_FIXTURE_CACHE, eventId, source);

export const enqueueLiveBonusCache = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.LIVE_BONUS_CACHE, eventId, source);

export const enqueueEventOverallResult = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_OVERALL_RESULT, eventId, source);

export const enqueueLiveScoresSync = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.LIVE_SCORES, eventId, source);
