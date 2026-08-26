import { Worker, Job, QueueEvents } from 'bullmq';

import {
  shouldCascadePersistedLiveSnapshot,
  shouldSkipQueuedLiveSnapshot,
} from '../domain/live-snapshot';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  LIVE_JOBS,
  type LiveDataJobData,
  liveDataQueue,
  liveDataQueueName,
} from '../queues/live-data.queue';
import {
  enqueueFinalLeagueResultsAfterLiveSync,
  isLiveMatchWindowForEvent,
} from '../services/live-data-cascade.service';
import { syncLiveSnapshot } from '../services/live-snapshot.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { isTerminalJobFailure } from '../utils/worker-failure';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../repositories/scheduler-obligations';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';

/**
 * Live Data Worker
 *
 * Processes live data sync jobs:
 * - live-snapshot: coherent upstream fetch + atomic Redis publication (30-sec)
 * - optional durable event-live persistence and the final-results cascade
 */
async function processLiveDataJob(job: Job<LiveDataJobData>) {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }
  const season = await requireCurrentSeasonForJob(job.data);
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

  return runTrackedJob(context, async () => {
    if (job.name !== LIVE_JOBS.LIVE_SNAPSHOT) {
      throw new Error(`Unknown job name: ${job.name}`);
    }
    const persistEventLives = job.data.persistEventLives ?? false;
    if (source === 'cron') {
      const windowOpen = await isLiveMatchWindowForEvent(season, eventId);
      if (shouldSkipQueuedLiveSnapshot(source, persistEventLives, windowOpen)) {
        logInfo('Skipping cache-only live snapshot job - not match time', {
          season: season.seasonCode,
          eventId,
        });
        return;
      }
    }
    const snapshot = await syncLiveSnapshot(season, eventId, {
      persistEventLives,
      finalizeEvent: job.data.finalizeEvent === true,
      trigger: source,
      mutationScopes: ['data-core:fixtures', `live-snapshot:event:${eventId}`],
      sourceRunId: job.data.runId,
      freshnessWindowId: job.data.freshnessWindowId,
    });
    // A failed downstream enqueue causes BullMQ to retry this parent after the
    // canonical live write has already committed. On that retry the unchanged
    // snapshot path correctly reports `persistedEventLives: false`; the durable
    // job intent still makes the idempotent cascade eligible.
    if (
      shouldCascadePersistedLiveSnapshot(snapshot) ||
      (job.attemptsMade > 0 && persistEventLives)
    ) {
      await enqueueFinalLeagueResultsAfterLiveSync(season, eventId);
    }
    return snapshot;
  });
}

export function createLiveDataWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<LiveDataJobData>(liveDataQueueName, processLiveDataJob, {
    connection,
    // Publication persistence owns the small DB pool; FPL request admission
    // separately caps the host at five and reserves live slots.
    concurrency: 2,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(liveDataQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Live data worker completed job', {
      jobId: job.id,
      jobName: job.name,
      eventId: job.data.eventId,
    });
    if (job.id !== undefined) {
      const fence = inspectSchedulerObligationFence(job.data);
      const evidence = {
        queue: liveDataQueueName,
        jobName: job.name,
        eventId: job.data.eventId,
      };
      const completion =
        fence.kind === 'complete'
          ? completeSchedulerObligation({
              obligationId: fence.obligationId,
              generation: fence.generation,
              status: 'succeeded',
              evidence,
            })
          : fence.kind === 'none'
            ? completeSchedulerObligationByBullJobId({ bullJobId: job.id, evidence })
            : null;
      if (completion) void completion.catch(() => undefined);
    }
  });
  worker.on('failed', (job, err) => {
    logError('Live data worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
    });
    if (job) {
      void alertOnFinalFailure(job, err);
      const fence = inspectSchedulerObligationFence(job.data);
      if (isTerminalJobFailure(job, err) && fence.kind === 'complete') {
        void failSchedulerObligation({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error: err,
        }).catch(() => undefined);
      } else if (job.id !== undefined && isTerminalJobFailure(job, err) && fence.kind === 'none') {
        void failSchedulerObligationByBullJobId({ bullJobId: job.id, error: err }).catch(
          () => undefined,
        );
      }
    }
  });
  worker.on('error', (err) => logError('Live data worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: liveDataQueue, queueEvents, queueName: liveDataQueueName }],
  };
}
