import { QueueEvents, Worker, type Job } from 'bullmq';

import { runBugReportCleanup } from '../services/bug-report-cleanup.service';
import { runBugReportScreenshotRetention } from '../services/bug-report-screenshot-retention.service';
import { repairPlayerSeasonSummaries } from '../services/player-season-summaries.service';
import { runPlayerMarketFreshnessWatchdog } from '../jobs/player-market-freshness.jobs';
import { repairTournamentTrendScopes } from '../jobs/tournament-trends-repair.jobs';
import { runLaunchMonitor } from '../jobs/launch.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import {
  MAINTENANCE_JOBS,
  maintenanceQueue,
  maintenanceQueueName,
  type MaintenanceJobData,
} from '../queues/maintenance.queue';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../repositories/scheduler-obligations';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { isTerminalJobFailure } from '../utils/worker-failure';
import type { WorkerRuntime } from './worker-runtime';

async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<unknown> {
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.source,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  return runTrackedJob(context, async () => {
    switch (job.name) {
      case MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS:
        return runPlayerMarketFreshnessWatchdog();
      case MAINTENANCE_JOBS.PLAYER_SEASON_SUMMARY:
        return repairPlayerSeasonSummaries();
      case MAINTENANCE_JOBS.TOURNAMENT_TRENDS:
        return repairTournamentTrendScopes();
      case MAINTENANCE_JOBS.BUG_REPORT_CLEANUP: {
        const result = await runBugReportCleanup();
        if (result.retried > 0) {
          throw new Error(`Bug report cleanup left ${result.retried} row(s) for retry`);
        }
        return result;
      }
      case MAINTENANCE_JOBS.BUG_REPORT_SCREENSHOT_RETENTION:
        return runBugReportScreenshotRetention();
      case MAINTENANCE_JOBS.LAUNCH_MONITOR:
        return runLaunchMonitor({ source: 'cron' });
      case MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION:
        return runPostMatchConsolidation();
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  });
}

export function createMaintenanceWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<MaintenanceJobData>(maintenanceQueueName, processMaintenanceJob, {
    connection,
    concurrency: 2,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(maintenanceQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Maintenance job completed', { jobId: job.id, name: job.name });
    if (job.id !== undefined) {
      const completion = job.data.obligationId
        ? completeSchedulerObligation({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            status: 'succeeded',
            evidence: { queue: maintenanceQueueName, jobName: job.name },
          })
        : completeSchedulerObligationByBullJobId({
            bullJobId: job.id,
            evidence: { queue: maintenanceQueueName, jobName: job.name },
          });
      void completion.catch(() => undefined);
    }
  });
  worker.on('failed', (job, error) => {
    logError('Maintenance job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job && isTerminalJobFailure(job, error) && job.data.obligationId) {
      void failSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        error,
      }).catch(() => undefined);
    } else if (job?.id !== undefined && isTerminalJobFailure(job, error)) {
      void failSchedulerObligationByBullJobId({ bullJobId: job.id, error }).catch(() => undefined);
    }
  });
  worker.on('error', (error) => logError('Maintenance worker error', error));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: maintenanceQueue, queueEvents, queueName: maintenanceQueueName }],
  };
}
