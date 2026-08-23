import { Job, QueueEvents, Worker } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { shouldStopManagerLiveRefresh } from '../domain/manager-live-refresh';
import { scheduleNextManagerLiveRefresh } from '../jobs/manager-live.jobs';
import {
  MANAGER_LIVE_JOBS,
  MANAGER_LIVE_JOB_VERSION,
  managerLiveQueue,
  managerLiveQueueName,
  type ManagerLiveJobData,
} from '../queues/manager-live.queue';
import { eventRepository } from '../repositories/events';
import {
  refreshManagerLiveScores,
  type ManagerLiveResolveResult,
} from '../services/manager-live.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import type { WorkerRuntime } from './worker-runtime';

export async function scheduleManagerLiveContinuation(
  jobData: ManagerLiveJobData,
  result: Pick<
    ManagerLiveResolveResult,
    'nextRefreshAt' | 'classicStandingsNextPage' | 'errorCode'
  >,
  schedule: typeof scheduleNextManagerLiveRefresh = scheduleNextManagerLiveRefresh,
): Promise<void> {
  // Preserve the six-hour hot chain even when one entry in a larger scope
  // fails. The current job still fails below so BullMQ applies 30/60/120s
  // retries, while the deduplicated follow-up keeps healthy managers fresh.
  await schedule(jobData, result.nextRefreshAt, result.classicStandingsNextPage);
  if (result.errorCode === 'UPSTREAM_RATE_LIMITED' || result.errorCode === 'UPSTREAM_UNAVAILABLE') {
    throw new Error(`Manager live refresh failed: ${result.errorCode}`);
  }
}

export async function processManagerLiveJob(job: Job<ManagerLiveJobData>) {
  if (job.name !== MANAGER_LIVE_JOBS.REFRESH || job.data.version !== MANAGER_LIVE_JOB_VERSION) {
    throw new Error(`Unsupported manager live job: ${job.name}@${job.data.version}`);
  }
  const season = await requireCurrentSeasonForJob(job.data);
  const event = await eventRepository.findById(season, job.data.eventId);
  if (!event) throw new Error(`Manager live event ${job.data.eventId} was not found`);

  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId: job.data.eventId,
    ...(job.data.tournamentId === undefined ? {} : { tournamentId: job.data.tournamentId }),
    source: job.data.source,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);

  return runTrackedJob(context, async () => {
    if (shouldStopManagerLiveRefresh(event)) {
      logInfo('Manager live refresh stopped after final event settlement', {
        eventId: job.data.eventId,
        tournamentId: job.data.tournamentId ?? null,
      });
      return { stopped: 'event-finalized' as const };
    }

    const result = await refreshManagerLiveScores({
      eventId: job.data.eventId,
      entryIds: job.data.entryIds,
      ...(job.data.tournamentId === undefined ? {} : { tournamentId: job.data.tournamentId }),
      ...(job.data.classicStandingsPage === undefined
        ? {}
        : { classicStandingsStartPage: job.data.classicStandingsPage }),
    });
    await scheduleManagerLiveContinuation(job.data, result);
    return result;
  });
}

export function createManagerLiveWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<ManagerLiveJobData>(managerLiveQueueName, processManagerLiveJob, {
    connection,
    concurrency: 2,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(managerLiveQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Manager live worker completed job', {
      jobId: job.id,
      eventId: job.data.eventId,
      tournamentId: job.data.tournamentId ?? null,
    });
  });
  worker.on('failed', (job, error) => {
    logError('Manager live worker failed job', error, {
      jobId: job?.id,
      eventId: job?.data.eventId,
      tournamentId: job?.data.tournamentId ?? null,
    });
    if (job && isTerminalJobFailure(job, error)) void alertOnFinalFailure(job, error);
  });
  worker.on('error', (error) => logError('Manager live worker error', error));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: managerLiveQueue, queueEvents, queueName: managerLiveQueueName }],
  };
}
