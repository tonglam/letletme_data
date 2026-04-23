import { Worker, Job, QueueEvents } from 'bullmq';

import { MUTATION_PRIORITY_ORDER, type MutationPriorityTier } from '../domain/job-priority';
import {
  LIVE_JOBS,
  type LiveDataJobData,
  getLiveDataQueueName,
  isLiveDataTieredQueueEnabled,
  liveDataQueuesByTier,
} from '../queues/live-data.queue';
import { syncEventLives, updateEventLivesCache } from '../services/event-lives.service';
import { getCurrentEvent } from '../services/events.service';
import { syncLiveFixtureCache } from '../services/live-fixtures.service';
import { syncLiveBonusCache } from '../services/live-bonus.service';
import { syncEventLiveSummary } from '../services/event-live-summaries.service';
import { syncEventLiveExplain } from '../services/event-live-explains.service';
import { syncEventOverallResult } from '../services/event-overall-results.service';
import { syncLiveScores } from '../services/fixtures.service';
import { isMatchDayTime } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import {
  enqueueEventLiveSummary,
  enqueueEventLiveExplain,
  enqueueLiveFixtureCache,
  enqueueLiveBonusCache,
  enqueueEventOverallResult,
} from '../jobs/live-data.jobs';
import { startStrictPriorityGate } from './strict-priority-gate';
import type { WorkerRuntime } from './worker-runtime';

/**
 * Enqueue cascade jobs after event-lives DB sync completes
 * These jobs depend on fresh event_lives data
 */
async function isLiveMatchWindowForEvent(eventId: number): Promise<boolean> {
  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    return false;
  }
  if (currentEvent.id !== eventId) {
    return false;
  }
  const fixtures = await loadFixturesByEvent(eventId);
  return isMatchDayTime(currentEvent, fixtures, new Date());
}

async function enqueueCascadeJobs(eventId: number) {
  logInfo('Enqueueing cascade jobs after DB sync', { eventId });

  try {
    const matchWindowOpen = await isLiveMatchWindowForEvent(eventId);
    const enqueueTasks = [
      enqueueEventLiveSummary(eventId, 'cascade'),
      enqueueEventLiveExplain(eventId, 'cascade'),
      ...(matchWindowOpen
        ? [enqueueLiveFixtureCache(eventId, 'cascade'), enqueueLiveBonusCache(eventId, 'cascade')]
        : []),
      enqueueEventOverallResult(eventId, 'cascade'),
    ];

    if (!matchWindowOpen) {
      logInfo('Skipping live fixture/bonus cascade enqueue - not match time', { eventId });
    }

    // Enqueue dependent jobs
    const results = await Promise.allSettled(enqueueTasks);

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
        const jobNames = ['summary', 'explain', 'live-fixture', 'live-bonus', 'overall'];
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
async function processLiveDataJob(job: Job<LiveDataJobData>) {
  const { eventId, source } = job.data;
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
  };

  logJobTriggered(context);

  return withMutationConflictGuard(
    {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
      eventId,
    },
    () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case LIVE_JOBS.EVENT_LIVES_CACHE:
            if (!(await isLiveMatchWindowForEvent(eventId))) {
              logInfo('Skipping event lives cache job - not match time', { eventId });
              break;
            }
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

          case LIVE_JOBS.LIVE_FIXTURE_CACHE:
            if (!(await isLiveMatchWindowForEvent(eventId))) {
              logInfo('Skipping live fixture cache job - not match time', { eventId });
              break;
            }
            await syncLiveFixtureCache(eventId);
            break;

          case LIVE_JOBS.LIVE_BONUS_CACHE:
            if (!(await isLiveMatchWindowForEvent(eventId))) {
              logInfo('Skipping live bonus cache job - not match time', { eventId });
              break;
            }
            await syncLiveBonusCache(eventId);
            break;

          case LIVE_JOBS.EVENT_OVERALL_RESULT:
            await syncEventOverallResult();
            break;

          case LIVE_JOBS.LIVE_SCORES:
            await syncLiveScores(eventId);
            break;

          default:
            throw new Error(`Unknown job name: ${job.name}`);
        }
      }),
  );
}

export function createLiveDataWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const activeTiers = isLiveDataTieredQueueEnabled ? MUTATION_PRIORITY_ORDER : (['p3'] as const);
  const workers: Worker<LiveDataJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];

  for (const tier of activeTiers) {
    const queueName = getLiveDataQueueName(tier);
    const worker = new Worker<LiveDataJobData>(queueName, processLiveDataJob, {
      connection,
      concurrency: 5,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    });
    const events = new QueueEvents(queueName, { connection });

    worker.on('completed', (job) => {
      logInfo('Live data worker completed job', {
        jobId: job.id,
        jobName: job.name,
        eventId: job.data.eventId,
        tier,
      });
    });

    worker.on('failed', (job, err) => {
      logError('Live data worker failed job', err, {
        jobId: job?.id,
        jobName: job?.name,
        eventId: job?.data.eventId,
        tier,
      });
    });

    worker.on('error', (err) => {
      logError('Live data worker error', err, { tier });
    });

    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({
      queue: liveDataQueuesByTier[tier],
      queueEvents: events,
      queueName,
      tier,
    });
  }

  const workerByTier = buildWorkerTierMap(workers, activeTiers);
  const gate = startStrictPriorityGate(
    'live-data',
    {
      p0: { queue: liveDataQueuesByTier.p0, worker: workerByTier.p0 },
      p1: { queue: liveDataQueuesByTier.p1, worker: workerByTier.p1 },
      p2: { queue: liveDataQueuesByTier.p2, worker: workerByTier.p2 },
      p3: { queue: liveDataQueuesByTier.p3, worker: workerByTier.p3 },
    },
    { enabled: isLiveDataTieredQueueEnabled },
  );

  return { workers, queueEvents, monitorTargets, stop: gate.stop };
}

function buildWorkerTierMap(
  workers: Worker<LiveDataJobData>[],
  activeTiers: readonly MutationPriorityTier[],
): Record<MutationPriorityTier, Worker<LiveDataJobData>> {
  const fallback = workers[0];
  const workerByTier = {} as Record<MutationPriorityTier, Worker<LiveDataJobData>>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const index = activeTiers.indexOf(tier);
    workerByTier[tier] = index >= 0 ? workers[index] : fallback;
  }
  return workerByTier;
}
