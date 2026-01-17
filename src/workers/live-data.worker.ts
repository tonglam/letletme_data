import { Worker, Job } from 'bullmq';

import { liveDataQueueName, LIVE_JOBS, type LiveDataJobData } from '../queues/live-data.queue';
import { syncEventLives, updateEventLivesCache } from '../services/event-lives.service';
import { syncEventLiveSummary } from '../services/event-live-summaries.service';
import { syncEventLiveExplain } from '../services/event-live-explains.service';
import { syncEventOverallResult } from '../services/event-overall-results.service';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import {
  enqueueEventLiveSummary,
  enqueueEventLiveExplain,
  enqueueEventOverallResult,
} from '../jobs/live-data.jobs';

/**
 * Enqueue cascade jobs after event-lives DB sync completes
 * These jobs depend on fresh event_lives data
 */
async function enqueueCascadeJobs(eventId: number) {
  logInfo('Enqueueing cascade jobs after DB sync', { eventId });

  try {
    // Enqueue all dependent jobs to run in parallel
    const results = await Promise.allSettled([
      enqueueEventLiveSummary(eventId, 'cascade'),
      enqueueEventLiveExplain(eventId, 'cascade'),
      enqueueEventOverallResult(eventId, 'cascade'),
    ]);

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logInfo('Cascade jobs enqueued', {
      eventId,
      total: results.length,
      successful,
      failed,
    });

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const jobNames = ['summary', 'explain', 'overall'];
        logError('Failed to enqueue cascade job', result.reason, {
          eventId,
          jobName: jobNames[index],
        });
      }
    });
  } catch (error) {
    logError('Failed to enqueue cascade jobs', error, { eventId });
    throw error;
  }
}

/**
 * Live Data Worker
 *
 * Processes live data sync jobs:
 * - event-lives-cache: Fast cache-only updates (1-min)
 * - event-lives-db: Database persistence (10-min) + trigger cascade
 * - event-live-summary: Aggregate season totals (cascade)
 * - event-live-explain: Sync explain data (cascade)
 * - event-overall-result: Sync overall results (cascade)
 */
export const liveDataWorker = new Worker<LiveDataJobData>(
  liveDataQueueName,
  async (job: Job<LiveDataJobData>) => {
    const { eventId, source } = job.data;

    logInfo('Processing live data job', {
      jobId: job.id,
      jobName: job.name,
      eventId,
      source,
      attempt: job.attemptsMade + 1,
    });

    try {
      switch (job.name) {
        case LIVE_JOBS.EVENT_LIVES_CACHE:
          await updateEventLivesCache(eventId);
          break;

        case LIVE_JOBS.EVENT_LIVES_DB:
          await syncEventLives(eventId);
          // After DB sync completes, trigger dependent jobs
          await enqueueCascadeJobs(eventId);
          break;

        case LIVE_JOBS.EVENT_LIVE_SUMMARY:
          await syncEventLiveSummary();
          break;

        case LIVE_JOBS.EVENT_LIVE_EXPLAIN:
          await syncEventLiveExplain(eventId);
          break;

        case LIVE_JOBS.EVENT_OVERALL_RESULT:
          await syncEventOverallResult();
          break;

        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }

      logInfo('Live data job completed', {
        jobId: job.id,
        jobName: job.name,
        eventId,
        attempt: job.attemptsMade + 1,
      });
    } catch (error) {
      logError('Live data job failed', error, {
        jobId: job.id,
        jobName: job.name,
        eventId,
        attempt: job.attemptsMade + 1,
      });
      throw error;
    }
  },
  {
    connection: getQueueConnection(),
    concurrency: 5, // Process up to 5 jobs in parallel
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
);

liveDataWorker.on('completed', (job) => {
  logInfo('Live data worker completed job', {
    jobId: job.id,
    jobName: job.name,
    eventId: job.data.eventId,
  });
});

liveDataWorker.on('failed', (job, err) => {
  logError('Live data worker failed job', err, {
    jobId: job?.id,
    jobName: job?.name,
    eventId: job?.data.eventId,
  });
});

liveDataWorker.on('error', (err) => {
  logError('Live data worker error', err);
});
