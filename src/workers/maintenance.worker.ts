import { QueueEvents, Worker, type Job } from 'bullmq';

import { runBugReportCleanup } from '../services/bug-report-cleanup.service';
import { runBugReportScreenshotRetention } from '../services/bug-report-screenshot-retention.service';
import { purgeClientSignalRetention } from '../services/client-signals.service';
import { repairPlayerSeasonSummaries } from '../services/player-season-summaries.service';
import { runPlayerMarketFreshnessWatchdog } from '../jobs/player-market-freshness.jobs';
import { repairTournamentTrendScopes } from '../jobs/tournament-trends-repair.jobs';
import {
  processTournamentReviewObligations,
  type TournamentReviewCorrection,
} from '../services/tournament-review-publication.service';
import { runLaunchMonitor } from '../jobs/launch.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import { reconcileUnderstatOrphanedRuns } from '../services/understat-recovery.service';
import { enqueueCoreSnapshotJob, enqueuePlayerStatsSyncJob } from '../jobs/data-sync-enqueue';
import { requireCurrentSeasonForJob } from '../services/season-scoped-job.service';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import { enqueueTournamentRosterSync } from '../jobs/tournament-sync.jobs';
import {
  captureMyFplSnapshot,
  assessMyFplFinalizationReadiness,
  dispatchMyFplSnapshotPublicationOutbox,
  getActiveMyFplSnapshotRedisManifest,
  getActiveMyFplPublication,
  getMyFplFinalizationControlStateForEvent,
  invalidateMyFplSnapshotRedisManifest,
  isMyFplSnapshotRedisManifestForPublication,
  MyFplSnapshotIncompleteError,
  requeueDeliveredMyFplSnapshotPublication,
  verifyMyFplSnapshotScopeGeneration,
  type MyFplSnapshotOutboxDeliveryEvidence,
  type MyFplSnapshotPublication,
} from '../services/my-fpl-snapshot-publication.service';
import { dispatchMyFplSnapshotInvalidationOutbox } from '../services/my-fpl-snapshot-invalidation.service';
import { dispatchDataPublicationOutbox } from '../services/data-publication-delivery.service';
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
  appendSchedulerObligationRecovery,
  deferSchedulerObligationForWorker,
  markSchedulerObligationRetrying,
  renewSchedulerObligation,
} from '../repositories/scheduler-obligations';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../services/scheduler-obligation-lifecycle.service';
import { getQueueConnection } from '../utils/queue';
import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';
import { resolveJobFreshAfter } from '../utils/job-freshness';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { createQueueRunAttemptId } from '../utils/queue-run-id';
import { seasonRefFromJobData } from '../domain/season-scoped-job';
import type { WorkerRuntime } from './worker-runtime';
import {
  markFreshnessWindowNotApplicable,
  recordFreshnessObservation,
  recordMyFplPublicationRedisEvidence,
} from '../services/data-governance.service';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
const SCHEDULER_LEASE_HEARTBEAT_MS = 60_000;

function nextMaintenanceRetryAt(job: Job<MaintenanceJobData>): Date {
  const attemptsMade = Math.max(1, job.attemptsMade);
  const configuredBackoff = job.opts.backoff;
  const backoff =
    typeof configuredBackoff === 'number'
      ? { type: 'fixed', delay: configuredBackoff }
      : configuredBackoff && typeof configuredBackoff === 'object'
        ? configuredBackoff
        : null;
  const baseDelayMs =
    backoff && typeof backoff.delay === 'number' && Number.isFinite(backoff.delay)
      ? Math.max(0, backoff.delay)
      : 0;
  const delayMs =
    backoff?.type === 'exponential'
      ? baseDelayMs * 2 ** Math.max(0, attemptsMade - 1)
      : baseDelayMs;
  return new Date(Date.now() + delayMs);
}

/**
 * A My FPL outbox job can deliver more than one event revision in one batch.
 * Persist evidence for every activated event window, while using only the
 * matching publication revision for the periodic window that triggered this
 * call. Consumer probes still have to prove final parity.
 */
async function recordMyFplOutboxRedisEvidence(input: {
  freshnessWindowId?: number;
  deliveredEvidence?: readonly MyFplSnapshotOutboxDeliveryEvidence[];
  publication?: MyFplSnapshotPublication | null;
  redisRevision?: number;
}): Promise<void> {
  const windowId = input.freshnessWindowId;
  const deliveryEvidence = (input.deliveredEvidence ?? [])
    .filter(
      (evidence) =>
        Number.isSafeInteger(evidence.seasonId) &&
        evidence.seasonId > 0 &&
        Number.isSafeInteger(evidence.eventId) &&
        evidence.eventId > 0 &&
        Number.isSafeInteger(evidence.revision) &&
        evidence.revision > 0 &&
        Number.isFinite(Date.parse(evidence.sourceCheckedAt)) &&
        Number.isFinite(Date.parse(evidence.publishedAt)),
    )
    .sort((left, right) => right.revision - left.revision);
  const publication = input.publication;
  const publicationEvidence =
    publication &&
    Number.isSafeInteger(input.redisRevision) &&
    input.redisRevision === publication.revision
      ? {
          seasonId: publication.seasonId,
          eventId: publication.eventId,
          revision: publication.revision,
          kind: publication.kind,
          sourceCheckedAt: publication.sourceCheckedAt.toISOString(),
          publishedAt: publication.publishedAt.toISOString(),
        }
      : null;
  const evidenceCandidates =
    deliveryEvidence.length > 0
      ? deliveryEvidence
      : publicationEvidence
        ? [publicationEvidence]
        : [];
  if (evidenceCandidates.length === 0) return;
  const redisSeenAt = new Date();
  try {
    for (const evidence of evidenceCandidates) {
      const sourceCheckedAt = new Date(evidence.sourceCheckedAt);
      const pgPublishedAt = new Date(evidence.publishedAt);
      await recordMyFplPublicationRedisEvidence({
        seasonId: evidence.seasonId,
        eventId: evidence.eventId,
        revision: evidence.revision,
        kind: evidence.kind,
        sourceCheckedAt,
        pgPublishedAt,
        redisSeenAt,
      });
    }
    if (!Number.isSafeInteger(windowId) || (windowId ?? 0) <= 0) return;
    const selected = publication
      ? (deliveryEvidence.find(
          (evidence) =>
            evidence.eventId === publication.eventId && evidence.revision === publication.revision,
        ) ?? publicationEvidence)
      : deliveryEvidence[0];
    if (!selected) return;
    const sourceCheckedAt = new Date(selected.sourceCheckedAt);
    const pgPublishedAt = new Date(selected.publishedAt);
    await recordFreshnessObservation({
      windowId: windowId!,
      sourceCheckedAt,
      pgPublishedAt,
      redisSeenAt,
      producerRevision: String(selected.revision),
      redisRevision: String(selected.revision),
      completenessStatus: 'COMPLETE',
    });
  } catch (error) {
    // Delivery is already durable; a governance evidence outage must not turn
    // a successful Redis activation into a duplicate outbox retry.
    logError('My FPL outbox governance evidence update failed', error, { windowId });
  }
}

function maintenanceCompletionEvidence(jobName: string, result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Record<string, unknown>;
  if (value.freshnessEvidenceRecorded === true) {
    return { freshnessEvidenceRecorded: true };
  }
  if (jobName === MAINTENANCE_JOBS.MY_FPL_SNAPSHOT) {
    const publication = value.publication;
    if (!publication || typeof publication !== 'object' || Array.isArray(publication)) return {};
    const candidate = publication as Record<string, unknown>;
    const revision = candidate.revision;
    const expectedCount = candidate.expectedEntryCount;
    const readyCount = candidate.readyEntryCount;
    const emptyCount = candidate.emptyEntryCount;
    if (
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      typeof expectedCount !== 'number' ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      typeof readyCount !== 'number' ||
      !Number.isSafeInteger(readyCount) ||
      readyCount < 0 ||
      typeof emptyCount !== 'number' ||
      !Number.isSafeInteger(emptyCount) ||
      emptyCount < 0
    ) {
      return {};
    }
    return {
      revision,
      snapshotRevision: revision,
      expectedCount,
      observedCount: readyCount + emptyCount,
      complete: true,
    };
  }
  if (jobName !== MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX) return {};
  const deliveredEvidence = value.deliveredEvidence;
  if (!Array.isArray(deliveredEvidence)) return {};
  const evidence = deliveredEvidence
    .filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const revision = (item as Record<string, unknown>).revision;
      return Number.isSafeInteger(revision) && Number(revision) > 0;
    })
    .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
  if (!evidence) return {};
  return {
    revision: evidence.revision,
    publicationRevision: evidence.revision,
    complete: true,
  };
}

function maintenanceResultDeferredSchedulerObligation(jobName: string, result: unknown): boolean {
  if (jobName !== MAINTENANCE_JOBS.MY_FPL_SNAPSHOT) return false;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return (result as Record<string, unknown>).status === 'waiting-dependencies';
}

async function persistManualMyFplRecoveryEvidence(
  job: Job<MaintenanceJobData>,
  result: unknown,
): Promise<void> {
  if (
    job.name !== MAINTENANCE_JOBS.MY_FPL_SNAPSHOT ||
    job.data.source !== 'manual' ||
    job.data.snapshotKind !== 'FINAL' ||
    !Number.isSafeInteger(job.data.eventId) ||
    (job.data.eventId ?? 0) <= 0 ||
    !job.data.snapshotActor ||
    !job.data.snapshotReason ||
    !job.data.snapshotIdempotencyKey ||
    !job.data.schedulerRecoveryTarget
  ) {
    return;
  }
  const completionEvidence = maintenanceCompletionEvidence(job.name, result);
  const recoveryRevision = completionEvidence.revision;
  if (
    !Number.isSafeInteger(recoveryRevision) ||
    Number(recoveryRevision) <= 0 ||
    !job.data.seasonCode
  ) {
    return;
  }
  const changed = await appendSchedulerObligationRecovery({
    jobName: 'my-fpl-finalization',
    scopeKey: `${job.data.seasonCode}:event:${job.data.eventId}`,
    obligationId: job.data.schedulerRecoveryTarget.obligationId,
    periodKey: job.data.schedulerRecoveryTarget.periodKey,
    generation: job.data.schedulerRecoveryTarget.generation,
    recoveryRevision: Number(recoveryRevision),
    recoveryActor: job.data.snapshotActor,
    recoveryReason: job.data.snapshotReason,
  });
  if (!changed) {
    throw new Error(
      `Manual My FPL FINAL recovery target ${job.data.schedulerRecoveryTarget.obligationId} is no longer eligible`,
    );
  }
  logInfo('Manual My FPL FINAL recovery evidence persisted before completion', {
    eventId: job.data.eventId,
    revision: recoveryRevision,
    changed,
    source: job.data.source,
  });
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
            playerValuesBullJobId: job.data.playerValuesBullJobId,
          });
        case MAINTENANCE_JOBS.PLAYER_SEASON_SUMMARY:
          return repairPlayerSeasonSummaries();
        case MAINTENANCE_JOBS.TOURNAMENT_TRENDS: {
          const season = seasonRefFromJobData(job.data);
          return repairTournamentTrendScopes({
            freshnessWindowId: job.data.freshnessWindowId,
            scope: { season, eventId: job.data.eventId ?? null },
          });
        }
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
        case MAINTENANCE_JOBS.TOURNAMENT_REVIEW: {
          const season = await requireCurrentSeasonForJob(job.data);
          const correction: TournamentReviewCorrection | undefined =
            job.data.reviewMode === 'CORRECTION' &&
            job.data.reviewCorrectionReason &&
            job.data.reviewCorrectionChangeId
              ? {
                  mode: 'CORRECTION',
                  reason: job.data.reviewCorrectionReason,
                  changeId: job.data.reviewCorrectionChangeId,
                }
              : undefined;
          return processTournamentReviewObligations(season, {
            // Creation-triggered jobs carry a precise tournament target so a
            // custom tournament can bootstrap its historical bundles now,
            // without waiting for the five-minute global scan.
            limit: job.data.tournamentId ? 100 : 20,
            tournamentId: job.data.tournamentId,
            eventId: job.data.eventId,
            ...(correction ? { correction } : {}),
          });
        }
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
          // Deletion tombstones share the same Redis pointer as publication
          // activation. Drain them first so a stale deleted revision cannot
          // win a race with this capture's publication outbox.
          const invalidation = await dispatchMyFplSnapshotInvalidationOutbox({
            limit: 20,
            seasonId: season.seasonId,
            eventId,
          });
          if (invalidation.failed > 0) {
            throw new Error(
              `My FPL invalidation outbox left ${invalidation.failed} receipt(s) for retry`,
            );
          }
          const active = await getActiveMyFplPublication(season, eventId);
          const hasExplicitFinalOverride =
            snapshotKind === 'FINAL' &&
            Boolean(job.data.snapshotActor) &&
            Boolean(job.data.snapshotReason) &&
            Boolean(job.data.snapshotIdempotencyKey);
          // Read one event's durable scope fence before deciding whether a
          // FINAL job can be a no-op. A clean fence plus a valid Redis
          // manifest takes the lightweight verification path below; it never
          // calls the deep readiness audit or full snapshot capture.
          const finalizationControl =
            snapshotKind === 'FINAL'
              ? await getMyFplFinalizationControlStateForEvent(season, eventId)
              : null;
          const activeFinalScopeGenerationVerified = Boolean(
            snapshotKind === 'FINAL' &&
              !hasExplicitFinalOverride &&
              active &&
              active.kind === 'FINAL' &&
              finalizationControl &&
              finalizationControl.activeRevision === active.revision &&
              finalizationControl.entryScopeGeneration !== null &&
              finalizationControl.entryScopeGeneration ===
                finalizationControl.verifiedEntryScopeGeneration &&
              finalizationControl.tournamentScopeGeneration !== null &&
              finalizationControl.tournamentScopeGeneration ===
                finalizationControl.verifiedTournamentScopeGeneration &&
              finalizationControl.verifiedRevision === active.revision,
          );
          // A clean generation fence is sufficient here. No snapshot-child
          // scan is needed on the stable worker path; missing or dirty FINALs
          // fall through to the worker-only deep capture path.
          if (activeFinalScopeGenerationVerified) {
            if (!active || !finalizationControl) {
              throw new MyFplSnapshotIncompleteError(
                `My FPL finalization control is unavailable for event ${eventId}`,
              );
            }
            const control = finalizationControl;
            const entryScopeGeneration = control.entryScopeGeneration;
            const tournamentScopeGeneration = control.tournamentScopeGeneration;
            if (entryScopeGeneration === null || tournamentScopeGeneration === null) {
              throw new MyFplSnapshotIncompleteError(
                `My FPL scope generation is unavailable for event ${eventId}`,
              );
            }
            let redisManifest = await getActiveMyFplSnapshotRedisManifest(
              season.seasonCode,
              eventId,
            );
            if (
              !isMyFplSnapshotRedisManifestForPublication(
                redisManifest,
                active,
                season.seasonCode,
                eventId,
              )
            ) {
              // A corrupt pointer cannot be overwritten by the activation
              // Lua (it deliberately fails closed). Clear only the exact
              // active revision before replaying its durable outbox receipt;
              // a newer pointer is fenced and remains untouched.
              await invalidateMyFplSnapshotRedisManifest(
                season.seasonCode,
                eventId,
                active.revision,
              );
              await requeueDeliveredMyFplSnapshotPublication(season, eventId, active.revision);
              const replay = await dispatchMyFplSnapshotPublicationOutbox({
                limit: 1,
                seasonCode: season.seasonCode,
                eventId,
              });
              if (replay.failed > 0) {
                throw new Error(
                  `My FPL snapshot Redis replay left ${replay.failed} delivery receipt(s) for retry`,
                );
              }
              redisManifest = await getActiveMyFplSnapshotRedisManifest(season.seasonCode, eventId);
            }
            if (
              isMyFplSnapshotRedisManifestForPublication(
                redisManifest,
                active,
                season.seasonCode,
                eventId,
              ) &&
              (await verifyMyFplSnapshotScopeGeneration({
                season,
                eventId,
                revision: active.revision,
                generation: {
                  entry: entryScopeGeneration,
                  tournament: tournamentScopeGeneration,
                },
              }))
            ) {
              await recordMyFplOutboxRedisEvidence({
                freshnessWindowId: job.data.freshnessWindowId,
                publication: active,
                redisRevision: redisManifest.revision,
              });
              await persistManualMyFplRecoveryEvidence(job, {
                status: 'noop',
                publication: active,
              });
              return { status: 'noop', publication: active };
            }
          }

          // A previously published FINAL is not sufficient evidence by itself
          // when the generation fence is dirty or unavailable. Only this
          // single-event worker runs the deep readiness audit, and only after
          // the lightweight no-op path has failed.
          const finalizationReadiness =
            snapshotKind === 'FINAL'
              ? await assessMyFplFinalizationReadiness(season, eventId)
              : null;
          if (finalizationReadiness && !finalizationReadiness.ready) {
            let transferRefreshEnqueued = false;
            if (
              snapshotKind === 'FINAL' &&
              finalizationReadiness.dataCheckedAt &&
              finalizationReadiness.missingTransferEntryIds.length > 0
            ) {
              // The normal post-deadline transfer obligation can finish before
              // FPL exposes data_checked. Refresh only the stale/missing IDs
              // after that immutable fence; never start a second full scan.
              const transferRefreshScope =
                finalizationReadiness.entryScopeSha256 ?? 'unknown-entry-scope';
              await enqueueEntryTransfersSyncJob(season, 'catchup', {
                entryIds: [...finalizationReadiness.missingTransferEntryIds],
                eventId,
                freshAfter: finalizationReadiness.dataCheckedAt,
                queueKey: `my-fpl-finalization-transfers-${season.seasonId}-${eventId}-${transferRefreshScope}`,
                deduplicationId: `my-fpl-finalization-transfers-${season.seasonId}-${eventId}-${finalizationReadiness.dataCheckedAt}-${transferRefreshScope}`,
                deduplicationCadenceMs: 60_000,
                removeOnSettle: false,
              });
              transferRefreshEnqueued = true;
            }
            const fence = inspectSchedulerObligationFence(job.data);
            if (fence.kind !== 'complete') {
              // A manually enqueued FINAL has no scheduler obligation to
              // defer. Treat an incomplete readiness contract as a visible
              // execution failure instead of allowing Bull's completed event
              // to acknowledge a job that did not publish anything.
              throw new MyFplSnapshotIncompleteError(
                `My FPL FINAL prerequisites are incomplete: ${
                  finalizationReadiness.reasonCodes.join(',') || 'unknown'
                }`,
              );
            }
            await deferSchedulerObligationForWorker({
              obligationId: fence.obligationId,
              generation: fence.generation,
              delayMs: 60_000,
              evidence: {
                eventId,
                readiness: {
                  expectedEntryCount: finalizationReadiness.expectedEntryCount,
                  observedEntryCount: finalizationReadiness.observedEntryCount,
                  notApplicableEntryCount: finalizationReadiness.notApplicableEntryCount,
                  entryScopeSha256: finalizationReadiness.entryScopeSha256,
                  expectedTournamentCount: finalizationReadiness.expectedTournamentCount,
                  observedTournamentCount: finalizationReadiness.observedTournamentCount,
                  tournamentScopeSha256: finalizationReadiness.tournamentScopeSha256,
                  missingEntryIds: finalizationReadiness.missingEntryIds.slice(0, 100),
                  missingTransferEntryIds: finalizationReadiness.missingTransferEntryIds.slice(
                    0,
                    100,
                  ),
                  reasonCodes: finalizationReadiness.reasonCodes,
                },
              },
            });
            return {
              status: 'waiting-dependencies',
              readiness: finalizationReadiness,
              transferRefreshEnqueued,
            };
          }

          if (snapshotKind !== 'FINAL') {
            // Refresh the mutable inputs for this retry attempt first. For a
            // FINAL capture, FPL's data_checked timestamp is the immutable
            // authority fence: using the coordinator wall clock would force a
            // full provider fan-out on every retry even though the source is
            // already frozen. Fall back to the normal ordering timestamp when
            // the event has no usable finalization fence, preserving fail-closed
            // behavior for malformed or stale jobs.
            const freshAfter = await resolveJobFreshAfter(job);
            const attemptKey = createQueueRunAttemptId();
            const source = 'catchup';
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
          }
          const captureOptions = {
            ...(job.data.snapshotActor ? { actor: job.data.snapshotActor } : {}),
            ...(job.data.snapshotReason ? { reason: job.data.snapshotReason } : {}),
            ...(job.data.snapshotIdempotencyKey
              ? { idempotencyKey: job.data.snapshotIdempotencyKey }
              : {}),
          };
          const capture = await captureMyFplSnapshot(season, eventId, snapshotKind, captureOptions);
          // An idempotent FINAL override may resolve to its original inactive
          // publication after a newer revision has become active. Delivery
          // evidence must certify the current active publication, not the
          // historical idempotency result, while retaining the noop outcome.
          const publicationForDelivery =
            capture.status === 'noop'
              ? await getActiveMyFplPublication(season, eventId)
              : capture.publication;
          if (!publicationForDelivery) {
            throw new Error('My FPL snapshot has no active publication for Redis delivery');
          }
          const redis = await dispatchMyFplSnapshotPublicationOutbox({
            limit: 20,
            eventId,
            seasonCode: season.seasonCode,
          });
          if (redis.failed > 0 || (redis.remaining ?? 0) > 0) {
            throw new Error(
              `My FPL snapshot Redis outbox remains incomplete: failed=${redis.failed}, remaining=${redis.remaining ?? 0}`,
            );
          }
          const activeRedisManifest = await getActiveMyFplSnapshotRedisManifest(
            season.seasonCode,
            eventId,
          );
          if (
            !isMyFplSnapshotRedisManifestForPublication(
              activeRedisManifest,
              publicationForDelivery,
              season.seasonCode,
              eventId,
            )
          ) {
            throw new Error(
              `My FPL snapshot Redis pointer does not match PostgreSQL publication revision ${publicationForDelivery.revision}`,
            );
          }
          await recordMyFplOutboxRedisEvidence({
            freshnessWindowId: job.data.freshnessWindowId,
            deliveredEvidence: redis.deliveredEvidence,
            publication: publicationForDelivery,
            redisRevision: activeRedisManifest.revision,
          });
          const result = { ...capture, publication: publicationForDelivery, invalidation, redis };
          await persistManualMyFplRecoveryEvidence(job, result);
          return result;
        }
        case MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX: {
          // Invalidation receipts are intentionally delivered before normal
          // publication receipts during the shared five-minute maintenance
          // cadence. A newer publication remains protected by the CAS.
          const invalidation = await dispatchMyFplSnapshotInvalidationOutbox({
            limit: 50,
            seasonId: job.data.seasonId,
          });
          if (invalidation.failed > 0) {
            throw new Error(
              `My FPL invalidation outbox left ${invalidation.failed} receipt(s) for retry`,
            );
          }
          const result = await dispatchMyFplSnapshotPublicationOutbox({
            limit: 50,
            seasonCode: job.data.seasonCode,
          });
          await recordMyFplOutboxRedisEvidence({
            freshnessWindowId: job.data.freshnessWindowId,
            deliveredEvidence: result.deliveredEvidence,
          });
          if (
            result.remaining === 0 &&
            result.delivered === 0 &&
            result.failed === 0 &&
            invalidation.remaining === 0
          ) {
            await markFreshnessWindowNotApplicable({
              windowId: job.data.freshnessWindowId ?? 0,
              reasonCode: 'OUTBOX_NO_PENDING_ACTIVE_PUBLICATION',
              evidence: { claimed: result.claimed, superseded: result.superseded },
            });
          }
          if (result.failed > 0) {
            throw new Error(
              `My FPL snapshot outbox left ${result.failed} delivery receipt(s) for retry`,
            );
          }
          return { ...result, invalidation };
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
    : ['maintenance', 'my-fpl-orchestration', 'publication-outbox'];
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
    worker.on('completed', (job, result) => {
      logInfo('Maintenance job completed', { jobId: job.id, name: job.name, lane });
      // The worker has already atomically deferred the scheduler obligation
      // when a FINAL prerequisite is missing. Bull reports this as a normal
      // completion, but it must not overwrite the persisted PENDING state as
      // SUCCEEDED.
      if (maintenanceResultDeferredSchedulerObligation(job.name, result)) return;
      if (job.id !== undefined) {
        const fence = inspectSchedulerObligationFence(job.data);
        const evidence = {
          queue: queueName,
          lane,
          jobName: job.name,
          ...maintenanceCompletionEvidence(job.name, result),
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
      } else if (job && !isTerminalJobFailure(job, error) && fence?.kind === 'complete') {
        void markSchedulerObligationRetrying({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error,
          nextAttemptAt: nextMaintenanceRetryAt(job),
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
