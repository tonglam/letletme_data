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
import { isTerminalJobFailure } from '../utils/worker-failure';
import { withMutationScopes } from '../utils/mutation-scopes';
import { resolveJobFreshAfter } from '../utils/job-freshness';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';

const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

function startSchedulerLeaseHeartbeat(job: Job<LeagueSyncJobData>): () => void {
  const obligationId = job.data.obligationId;
  if (!obligationId) return () => undefined;

  const timer = setInterval(() => {
    void renewSchedulerObligation({
      obligationId,
      generation: job.data.obligationGeneration,
    }).catch((error) => {
      logError('Failed to renew league scheduler obligation lease', error, {
        jobId: job.id,
        jobName: job.name,
        obligationId,
        generation: job.data.obligationGeneration,
      });
    });
  }, SCHEDULER_LEASE_HEARTBEAT_MS);

  return () => clearInterval(timer);
}

/**
 * League Sync Worker
 *
 * Processes league sync jobs:
 * - Coordinator job (no tournamentId): Synchronizes active tournaments with bounded fan-out
 * - Tournament job (with tournamentId): Processes that specific tournament
 */
async function processLeagueSyncJob(job: Job<LeagueSyncJobData>) {
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

  const stopLeaseHeartbeat = startSchedulerLeaseHeartbeat(job);
  try {
    return await runDataSyncAttempt(
      {
        queue: job.queueName,
        jobName: job.name,
        runId,
        source: tournamentId === undefined ? 'coordinator' : source,
        attempt: job.attemptsMade + 1,
        targetEventId: eventId,
        queueWaitMs: context.queueWaitMs,
      },
      () => {
        const operation = () =>
          runTrackedJob(context, async () => {
            switch (job.name) {
              case LEAGUE_JOBS.LEAGUE_EVENT_PICKS:
                return processLeagueEventPicksJob(season, eventId, tournamentId, runId);

              case LEAGUE_JOBS.LEAGUE_EVENT_RESULTS: {
                // One coordinator attempt owns one database-clock boundary.
                // Reusing it across tournaments avoids duplicate rich-result
                // fetches for entries shared by multiple leagues.
                const freshAfter = await resolveJobFreshAfter(job);
                return processLeagueEventResultsJob(season, eventId, tournamentId, {
                  runId,
                  freshAfter,
                });
              }

              default:
                throw new Error(`Unknown job name: ${job.name}`);
            }
          });

        // Coordinators acquire a short transaction per tournament in the
        // service. An outer transaction would retain event locks across the
        // complete network-heavy fan-out.
        if (tournamentId === undefined) return operation();
        return withMutationScopes(
          {
            queueName: job.queueName,
            jobName: job.name,
            jobId: String(job.id),
            eventId,
            tournamentId,
          },
          operation,
        );
      },
    );
  } finally {
    stopLeaseHeartbeat();
  }
}

export function createLeagueSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<LeagueSyncJobData>(leagueSyncQueueName, processLeagueSyncJob, {
    connection,
    // A coordinator already owns the full active-tournament scan and every
    // tournament shares event-level mutation scopes. Multiple coordinators
    // only contend on PostgreSQL locks and duplicate FPL reads.
    concurrency: 1,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
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
    if (job.id !== undefined) {
      const fence = inspectSchedulerObligationFence(job.data);
      const evidence = {
        queue: leagueSyncQueueName,
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
    logError('League sync worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
      tournamentId: job?.data.tournamentId,
    });
    if (job) void alertOnFinalFailure(job, err);
    const fence = job ? inspectSchedulerObligationFence(job.data) : null;
    if (job && isTerminalJobFailure(job, err) && fence?.kind === 'complete') {
      void failSchedulerObligation({
        obligationId: fence.obligationId,
        generation: fence.generation,
        error: err,
      }).catch(() => undefined);
    } else if (job?.id !== undefined && isTerminalJobFailure(job, err) && fence?.kind === 'none') {
      void failSchedulerObligationByBullJobId({ bullJobId: job.id, error: err }).catch(
        () => undefined,
      );
    }
  });
  worker.on('error', (err) => logError('League sync worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: leagueSyncQueue, queueEvents, queueName: leagueSyncQueueName }],
  };
}
