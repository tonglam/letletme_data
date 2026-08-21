import { Worker, Job, QueueEvents } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  leagueSyncQueue,
  leagueSyncQueueName,
  LEAGUE_JOBS,
  type LeagueSyncJobData,
} from '../queues/league-sync.queue';
import {
  processLeagueEventPicksJob,
  processLeagueEventResultsJob,
} from '../services/league-sync.service';
import { resolveBullMqAttemptQueueWaitMs, runDataSyncAttempt } from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { withMutationScopes } from '../utils/mutation-scopes';
import { resolveJobFreshAfter } from '../utils/job-freshness';
import type { WorkerRuntime } from './worker-runtime';

/**
 * League Sync Worker
 *
 * Processes league sync jobs:
 * - Coordinator job (no tournamentId): Enqueues one job per tournament
 * - Tournament job (with tournamentId): Processes that specific tournament
 */
async function processLeagueSyncJob(job: Job<LeagueSyncJobData>) {
  const season = await requireCurrentSeasonForJob(job.data);
  const { eventId, tournamentId, source } = job.data;
  const runId = job.data.runId ?? String(job.id ?? `${job.name}-${job.timestamp}`);
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
    tournamentId,
    queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
  };

  logJobTriggered(context);

  return runDataSyncAttempt(
    {
      queue: job.queueName,
      jobName: job.name,
      runId,
      source: tournamentId === undefined ? 'coordinator' : source,
      attempt: job.attemptsMade + 1,
      targetEventId: eventId,
      queueWaitMs: context.queueWaitMs,
    },
    () =>
      withMutationScopes(
        {
          queueName: job.queueName,
          jobName: job.name,
          jobId: String(job.id),
          eventId,
          tournamentId,
        },
        () =>
          runTrackedJob(context, async () => {
            switch (job.name) {
              case LEAGUE_JOBS.LEAGUE_EVENT_PICKS:
                return processLeagueEventPicksJob(season, eventId, tournamentId, runId);

              case LEAGUE_JOBS.LEAGUE_EVENT_RESULTS: {
                const freshAfter = tournamentId ? await resolveJobFreshAfter(job) : undefined;
                return processLeagueEventResultsJob(season, eventId, tournamentId, {
                  runId,
                  freshAfter,
                });
              }

              default:
                throw new Error(`Unknown job name: ${job.name}`);
            }
          }),
      ),
  );
}

export function createLeagueSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<LeagueSyncJobData>(leagueSyncQueueName, processLeagueSyncJob, {
    connection,
    concurrency: 10,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(leagueSyncQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('League sync worker completed job', {
      jobId: job.id,
      jobName: job.name,
      eventId: job.data.eventId,
      tournamentId: job.data.tournamentId,
    });
  });
  worker.on('failed', (job, err) => {
    logError('League sync worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
      tournamentId: job?.data.tournamentId,
    });
    if (job) void alertOnFinalFailure(job, err);
  });
  worker.on('error', (err) => logError('League sync worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: leagueSyncQueue, queueEvents, queueName: leagueSyncQueueName }],
  };
}
