import {
  liveDataQueue,
  LIVE_JOBS,
  type LiveDataJobName,
  type LiveDataJobData,
} from '../queues/live-data.queue';
import { logError, logInfo } from '../utils/logger';

export type LiveDataJobSource = 'cron' | 'manual' | 'cascade';

async function enqueueLiveDataJob(
  jobName: LiveDataJobName,
  eventId: number,
  source: LiveDataJobSource = 'cron',
  options: { delay?: number; jobId?: string } = {},
) {
  try {
    const jobData: LiveDataJobData = {
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
    };

    const defaultJobId = `${jobName}:${eventId}:${Date.now()}`;

    const job = await liveDataQueue.add(jobName, jobData, {
      jobId: options.jobId ?? defaultJobId,
      delay: options.delay,
    });

    logInfo('Live data job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      source,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue live data job', error, { jobName, eventId, source });
    throw error;
  }
}

export const enqueueEventLivesCacheUpdate = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVES_CACHE, eventId, source);

export const enqueueEventLivesDbSync = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVES_DB, eventId, source);

export const enqueueEventLiveSummary = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVE_SUMMARY, eventId, source);

export const enqueueEventLiveExplain = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_LIVE_EXPLAIN, eventId, source);

export const enqueueEventOverallResult = (eventId: number, source?: LiveDataJobSource) =>
  enqueueLiveDataJob(LIVE_JOBS.EVENT_OVERALL_RESULT, eventId, source);
