import { QueueEvents, Worker, type Job } from 'bullmq';

import { runBugReportCleanup } from '../services/bug-report-cleanup.service';
import { runBugReportScreenshotRetention } from '../services/bug-report-screenshot-retention.service';
import { purgeClientSignalRetention } from '../services/client-signals.service';
import { repairPlayerSeasonSummaries } from '../services/player-season-summaries.service';
import { runPlayerMarketFreshnessWatchdog } from '../jobs/player-market-freshness.jobs';
import { repairTournamentTrendScopes } from '../jobs/tournament-trends-repair.jobs';
import { runLaunchMonitor } from '../jobs/launch.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import { reconcileUnderstatOrphanedRuns } from '../services/understat-recovery.service';
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
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { runEntryOnboarding } from '../services/entry-onboarding.service';
import { runQueueRunPhase } from '../services/queue-run-barrier';
import { eventRepository } from '../repositories/events';
import {
  MAINTENANCE_JOBS,
  maintenanceLaneQueues,
  MAINTENANCE_LANE_QUEUE_NAMES,
  type MaintenanceLane,
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
import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';
import { resolveJobFreshAfter } from '../utils/job-freshness';
import { resolveFinalizationFreshAfter } from '../domain/entry-sync';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { createQueueRunAttemptId } from '../utils/queue-run-id';
import type { WorkerRuntime } from './worker-runtime';
import { recordFreshnessObservation } from '../services/data-governance.service';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

/**
 * A My FPL outbox job can deliver more than one event revision in one batch.
 * The linked governance window is a Redis milestone, so retain the newest
 * activated revision as evidence without pretending that one revision covers
 * every event in the batch. Consumer probes still have to prove final parity.
 */
async function recordMyFplOutboxRedisEvidence(input: {
  freshnessWindowId?: number;
  deliveredRevisions?: readonly number[];
}): Promise<void> {
  const windowId = input.freshnessWindowId;
  const revisions = (input.deliveredRevisions ?? []).filter(
    (revision): revision is number => Number.isSafeInteger(revision) && revision > 0,
  );
  if (!Number.isSafeInteger(windowId) || (windowId ?? 0) <= 0 || revisions.length === 0) return;
  const redisRevision = Math.max(...revisions);
  try {
    await recordFreshnessObservation({
      windowId: windowId!,
      redisSeenAt: new Date(),
      redisRevision: String(redisRevision),
    });
  } catch (error) {
    // Delivery is already durable; a governance evidence outage must not turn
    // a successful Redis activation into a duplicate outbox retry.
    logError('My FPL outbox governance evidence update failed', error, { windowId });
  }
}

function startSchedulerLeaseHeartbeat(job: Job<MaintenanceJobData>): () => void {
  const fence = inspectSchedulerObligationFence(job.data);
  if (fence.kind !== 'complete') return () => undefined;

  const timer = setInterval(() => {
    void renewSchedulerObligation({
      obligationId: fence.obligationId,
      generation: fence.generation,
    }).catch((error) => {
      logError('Failed to renew maintenance scheduler obligation lease', error, {
        jobId: job.id,
        jobName: job.name,
        obligationId: fence.obligationId,
        generation: fence.generation,
      });
    });
  }, SCHEDULER_LEASE_HEARTBEAT_MS);

  return () => clearInterval(timer);
}

async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<unknown> {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }
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
          return runPlayerMarketFreshnessWatchdog(new Date(), {
            freshnessWindowId: job.data.freshnessWindowId,
            sourceRunId: job.data.runId,
          });
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
        case MAINTENANCE_JOBS.CLIENT_SIGNAL_RETENTION:
          return purgeClientSignalRetention();
        case MAINTENANCE_JOBS.LAUNCH_MONITOR:
          return runLaunchMonitor({ source: 'cron' });
        case MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION:
          return runPostMatchConsolidation();
        case MAINTENANCE_JOBS.UNDERSTAT_ORPHAN_RECONCILER:
          return reconcileUnderstatOrphanedRuns();
        case MAINTENANCE_JOBS.ENTRY_ONBOARDING: {
          if (!Number.isSafeInteger(job.data.entryId) || (job.data.entryId ?? 0) <= 0) {
            throw new Error('Entry onboarding job is missing a valid entryId');
          }
          const season = await requireCurrentSeasonForJob(job.data);
          const entryInfoTargetEventId =
            (await eventRepository.findLatestFinalized(season))?.id ?? 0;
          return runEntryOnboarding(season, {
            entryId: job.data.entryId!,
            ...(job.data.eventId === undefined ? {} : { eventId: job.data.eventId }),
            entryInfoTargetEventId,
            attemptKey: createQueueRunAttemptId(),
          });
        }
        case MAINTENANCE_JOBS.MY_FPL_SNAPSHOT: {
          if (!job.data.eventId || !job.data.snapshotKind) {
            throw new Error('My FPL snapshot job is missing eventId or snapshotKind');
          }
          const eventId = job.data.eventId;
          const snapshotKind = job.data.snapshotKind;
          const season = await requireCurrentSeasonForJob(job.data);
          const active = await getActiveMyFplPublication(season, eventId);
          const hasExplicitFinalOverride =
            snapshotKind === 'FINAL' &&
            Boolean(job.data.snapshotActor) &&
            Boolean(job.data.snapshotReason) &&
            Boolean(job.data.snapshotIdempotencyKey);
          if (
            active?.kind === 'FINAL' &&
            (!hasExplicitFinalOverride || active.idempotencyKey === job.data.snapshotIdempotencyKey)
          ) {
            return { status: 'noop', publication: active };
          }

          // Refresh the mutable inputs for this retry attempt first. For a
          // FINAL capture, FPL's data_checked timestamp is the immutable
          // authority fence: using the coordinator wall clock would force a
          // full provider fan-out on every retry even though the source is
          // already frozen. Fall back to the normal ordering timestamp when
          // the event has no usable finalization fence, preserving fail-closed
          // behavior for malformed or stale jobs.
          const finalizationEvent =
            snapshotKind === 'FINAL' ? await eventRepository.findById(season, eventId) : null;
          const finalFreshAfter = resolveFinalizationFreshAfter(finalizationEvent);
          const freshAfter = finalFreshAfter ?? (await resolveJobFreshAfter(job));
          if (finalFreshAfter && job.data.freshAfter !== finalFreshAfter) {
            const updatedData = { ...job.data, freshAfter: finalFreshAfter };
            await job.updateData(updatedData);
            job.data = updatedData;
          }
          const attemptKey = createQueueRunAttemptId();
          const source = snapshotKind === 'FINAL' ? 'reconcile' : 'catchup';
          const entryInfoTargetEventId =
            (await eventRepository.findLatestFinalized(season))?.id ?? 0;
          await runQueueRunPhase(attemptKey, [
            enqueueCoreSnapshotJob(season, source, {
              jobId: `my-fpl-${attemptKey}-core`,
              runId: attemptKey,
              removeOnSettle: false,
            }),
            enqueuePlayerStatsSyncJob(season, source, {
              eventId,
              jobId: `my-fpl-${attemptKey}-player-stats`,
              runId: attemptKey,
              removeOnSettle: false,
            }),
            enqueueEntryInfoSyncJob(season, source, {
              eventId: entryInfoTargetEventId,
              jobId: `my-fpl-${attemptKey}-entry-info`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-info`,
              removeOnSettle: false,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueEntryPicksSyncJob(season, source, {
              eventId,
              jobId: `my-fpl-${attemptKey}-entry-picks`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-picks`,
              removeOnSettle: false,
            }),
            enqueueEntryResultsSyncJob(season, source, {
              eventId,
              freshAfter,
              jobId: `my-fpl-${attemptKey}-entry-results`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-results`,
              removeOnSettle: false,
            }),
            enqueueEntryTransfersSyncJob(season, source, {
              eventId,
              freshAfter,
              jobId: `my-fpl-${attemptKey}-entry-transfers`,
              runId: attemptKey,
              queueKey: `my-fpl-${attemptKey}-entry-transfers`,
              removeOnSettle: false,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentRosterSync(season, source, {
              finalizedEventId: eventId,
              jobId: `my-fpl-${attemptKey}-tournament-roster`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentEventResults(season, eventId, source, {
              freshAfter,
              jobId: `my-fpl-${attemptKey}-tournament-results`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentEventPicks(season, eventId, source, {
              jobId: `my-fpl-${attemptKey}-tournament-picks`,
              runId: attemptKey,
            }),
          ]);

          await runQueueRunPhase(attemptKey, [
            enqueueTournamentTransfersPre(season, eventId, source, {
              freshAfter,
              jobId: `my-fpl-${attemptKey}-tournament-transfers`,
              runId: attemptKey,
            }),
          ]);
          const capture = await captureMyFplSnapshot(season, eventId, snapshotKind, {
            ...(job.data.snapshotActor ? { actor: job.data.snapshotActor } : {}),
            ...(job.data.snapshotReason ? { reason: job.data.snapshotReason } : {}),
            ...(job.data.snapshotIdempotencyKey
              ? { idempotencyKey: job.data.snapshotIdempotencyKey }
              : {}),
          });
          const redis = await dispatchMyFplSnapshotPublicationOutbox({ limit: 20 });
          await recordMyFplOutboxRedisEvidence({
            freshnessWindowId: job.data.freshnessWindowId,
            deliveredRevisions: redis.deliveredRevisions,
          });
          return { ...capture, redis };
        }
        case MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX: {
          const result = await dispatchMyFplSnapshotPublicationOutbox({ limit: 50 });
          await recordMyFplOutboxRedisEvidence({
            freshnessWindowId: job.data.freshnessWindowId,
            deliveredRevisions: result.deliveredRevisions,
          });
          if (result.failed > 0) {
            throw new Error(
              `My FPL snapshot outbox left ${result.failed} delivery receipt(s) for retry`,
            );
          }
          return result;
        }
        case MAINTENANCE_JOBS.DATA_PUBLICATION_OUTBOX: {
          const result = await dispatchDataPublicationOutbox({ limit: 20 });
          if (result.failed > 0) {
            throw new Error(`Data publication outbox left ${result.failed} receipt(s) for retry`);
          }
          return result;
        }
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
  const laneConcurrency: Record<MaintenanceLane, number> = {
    maintenance: 1,
    'my-fpl-orchestration': 1,
    'publication-outbox': 2,
    'entry-onboarding': 2,
    'data-repair': 1,
    housekeeping: 1,
  };
  const lanes: MaintenanceLane[] = getConfig().QUEUE_LANES_V2_ENABLED
    ? (Object.keys(MAINTENANCE_LANE_QUEUE_NAMES) as MaintenanceLane[])
    : ['maintenance', 'publication-outbox'];
  const workers: Worker<MaintenanceJobData>[] = [];
  const queueEvents: QueueEvents[] = [];
  const monitorTargets: WorkerRuntime['monitorTargets'] = [];
  for (const lane of lanes) {
    const queueName = MAINTENANCE_LANE_QUEUE_NAMES[lane];
    const queue = maintenanceLaneQueues[lane];
    const worker = new Worker<MaintenanceJobData>(queueName, processMaintenanceJob, {
      connection,
      concurrency: laneConcurrency[lane],
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    });
    const events = new QueueEvents(queueName, { connection });
    worker.on('completed', (job) => {
      logInfo('Maintenance job completed', { jobId: job.id, name: job.name, lane });
      if (job.id !== undefined) {
        const fence = inspectSchedulerObligationFence(job.data);
        const evidence = { queue: queueName, lane, jobName: job.name };
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
    worker.on('failed', (job, error) => {
      logError('Maintenance job failed', error, {
        jobId: job?.id,
        name: job?.name,
        lane,
        attemptsMade: job?.attemptsMade,
      });
      const fence = job ? inspectSchedulerObligationFence(job.data) : null;
      if (job && isTerminalJobFailure(job, error) && fence?.kind === 'complete') {
        void failSchedulerObligation({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error,
        }).catch(() => undefined);
      } else if (
        job?.id !== undefined &&
        isTerminalJobFailure(job, error) &&
        fence?.kind === 'none'
      ) {
        void failSchedulerObligationByBullJobId({ bullJobId: job.id, error }).catch(
          () => undefined,
        );
      }
    });
    worker.on('error', (error) => logError('Maintenance worker error', error, { lane }));
    workers.push(worker);
    queueEvents.push(events);
    monitorTargets.push({ queue, queueEvents: events, queueName });
  }

  return { workers, queueEvents, monitorTargets };
}
