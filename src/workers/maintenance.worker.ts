import { QueueEvents, Worker, type Job } from 'bullmq';

import { runBugReportCleanup } from '../services/bug-report-cleanup.service';
import { runBugReportScreenshotRetention } from '../services/bug-report-screenshot-retention.service';
import { repairPlayerSeasonSummaries } from '../services/player-season-summaries.service';
import { runPlayerMarketFreshnessWatchdog } from '../jobs/player-market-freshness.jobs';
import { repairTournamentTrendScopes } from '../jobs/tournament-trends-repair.jobs';
import { runLaunchMonitor } from '../jobs/launch.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import { enqueueCoreSnapshotJob, enqueuePlayerStatsSyncJob } from '../jobs/data-sync-enqueue';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import {
  enqueueTournamentEventPicks,
  enqueueTournamentEventResults,
  enqueueTournamentRosterSync,
  enqueueTournamentTransfersPre,
} from '../jobs/tournament-sync.jobs';
import {
  captureMyFplSnapshot,
  dispatchMyFplSnapshotPublicationOutbox,
  getActiveMyFplPublication,
} from '../services/my-fpl-snapshot-publication.service';
import { runEntryOnboarding } from '../services/entry-onboarding.service';
import { runQueueRunPhase } from '../services/queue-run-barrier';
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
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { isTerminalJobFailure } from '../utils/worker-failure';
import type { WorkerRuntime } from './worker-runtime';
const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

function startSchedulerLeaseHeartbeat(job: Job<MaintenanceJobData>): () => void {
  const obligationId = job.data.obligationId;
  if (!obligationId) return () => undefined;

  const timer = setInterval(() => {
    void renewSchedulerObligation({
      obligationId,
      generation: job.data.obligationGeneration,
    }).catch((error) => {
      logError('Failed to renew maintenance scheduler obligation lease', error, {
        jobId: job.id,
        jobName: job.name,
        obligationId,
        generation: job.data.obligationGeneration,
      });
    });
  }, SCHEDULER_LEASE_HEARTBEAT_MS);

  return () => clearInterval(timer);
}

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
  const stopLeaseHeartbeat = startSchedulerLeaseHeartbeat(job);
  try {
    return await runTrackedJob(context, async () => {
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
        case MAINTENANCE_JOBS.ENTRY_ONBOARDING: {
          if (!Number.isSafeInteger(job.data.entryId) || (job.data.entryId ?? 0) <= 0) {
            throw new Error('Entry onboarding job is missing a valid entryId');
          }
          const season = await requireCurrentSeasonForJob(job.data);
          return runEntryOnboarding(season, {
            entryId: job.data.entryId!,
            ...(job.data.eventId === undefined ? {} : { eventId: job.data.eventId }),
            attemptKey: `${job.data.runId}-a${job.attemptsMade + 1}`,
          });
        }
        case MAINTENANCE_JOBS.MY_FPL_SNAPSHOT: {
          if (!job.data.eventId || !job.data.snapshotKind) {
            throw new Error('My FPL snapshot job is missing eventId or snapshotKind');
          }
          const season = await requireCurrentSeasonForJob(job.data);
          const active = await getActiveMyFplPublication(season, job.data.eventId);
          const hasExplicitFinalOverride =
            job.data.snapshotKind === 'FINAL' &&
            Boolean(job.data.snapshotActor) &&
            Boolean(job.data.snapshotReason) &&
            Boolean(job.data.snapshotIdempotencyKey);
          if (
            active?.kind === 'FINAL' &&
            (!hasExplicitFinalOverride || active.idempotencyKey === job.data.snapshotIdempotencyKey)
          ) {
            return { status: 'noop', publication: active };
          }

          // Refresh the mutable inputs for this retry attempt first. The
          // publication service remains fail-closed, so an upstream 503, a
          // missing row, or a partial sync leaves the previous active revision
          // serving while this job retries in 30 minutes.
          const attemptKey = `${job.data.runId}-a${job.attemptsMade + 1}`;
          const source = job.data.snapshotKind === 'FINAL' ? 'reconcile' : 'catchup';
          await runQueueRunPhase(attemptKey, [
            enqueueCoreSnapshotJob(season, source, {
              jobId: `my-fpl-${attemptKey}-core`,
              runId: attemptKey,
              removeOnSettle: false,
            }),
            enqueuePlayerStatsSyncJob(season, source, {
              eventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-player-stats`,
              runId: attemptKey,
              removeOnSettle: false,
            }),
            enqueueEntryInfoSyncJob(season, source, {
              eventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-entry-info`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-info`,
              removeOnSettle: false,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueEntryPicksSyncJob(season, source, {
              eventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-entry-picks`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-picks`,
              removeOnSettle: false,
            }),
            enqueueEntryResultsSyncJob(season, source, {
              eventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-entry-results`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-results`,
              removeOnSettle: false,
            }),
            enqueueEntryTransfersSyncJob(season, source, {
              eventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-entry-transfers`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-transfers`,
              removeOnSettle: false,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentRosterSync(season, source, {
              finalizedEventId: job.data.eventId,
              jobId: `my-fpl-${attemptKey}-tournament-roster`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentEventResults(season, job.data.eventId, source, {
              jobId: `my-fpl-${attemptKey}-tournament-results`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentEventPicks(season, job.data.eventId, source, {
              jobId: `my-fpl-${attemptKey}-tournament-picks`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentTransfersPre(season, job.data.eventId, source, {
              jobId: `my-fpl-${attemptKey}-tournament-transfers`,
              runId: attemptKey,
            }),
          ]);
          const capture = await captureMyFplSnapshot(
            season,
            job.data.eventId,
            job.data.snapshotKind,
            {
              ...(job.data.snapshotActor ? { actor: job.data.snapshotActor } : {}),
              ...(job.data.snapshotReason ? { reason: job.data.snapshotReason } : {}),
              ...(job.data.snapshotIdempotencyKey
                ? { idempotencyKey: job.data.snapshotIdempotencyKey }
                : {}),
            },
          );
          const redis = await dispatchMyFplSnapshotPublicationOutbox({ limit: 20 });
          return { ...capture, redis };
        }
        case MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX:
          return dispatchMyFplSnapshotPublicationOutbox({ limit: 50 });
        default:
          throw new Error(`Unknown maintenance job: ${job.name}`);
      }
    });
  } finally {
    stopLeaseHeartbeat();
  }
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
