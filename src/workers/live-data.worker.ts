import { UnrecoverableError, Worker, Job, QueueEvents } from 'bullmq';

import { requireCurrentSeasonForJob } from '../services/season-scoped-job.service';
import {
  LIVE_JOBS,
  type LiveDataJobData,
  liveDataQueue,
  liveDataQueueName,
} from '../queues/live-data.queue';
import { enqueueFinalLeagueResultsAfterLiveSync } from '../services/live-data-cascade.service';
import { enqueueRemainingLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import { syncLiveSnapshotV2 } from '../services/live-snapshot-v2.service';
import {
  LiveFinalRetentionIncompleteError,
  liveFinalRetentionCompletionEvidence,
  runLiveFinalRetentionV2,
  recordManualLiveFinalRetentionRecovery,
  assertManualLiveFinalRetentionRecoveryTarget,
} from '../services/live-final-retention.service';
import { syncLiveMatchObservationV3 } from '../services/live-match-observation-v3.service';
import {
  checkpointLiveMatchScopeV3,
  hasFinalLiveMatchCheckpointsV3,
} from '../services/live-match-v3-checkpoint.service';
import {
  syncLiveClassicLeaguePublicationsV2,
  syncLiveH2HLeaguePublicationsV2,
} from '../services/live-league-publication-v2.service';
import { ensureLiveAverageReadyForPublication } from '../services/live-average-refresh.service';
import {
  ensureLiveBootstrapReady,
  readLivePicksDurableFreshnessEvidence,
} from '../services/live-lifecycle-orchestrator';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logDebug, logError, logInfo, logWarn } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { createSeasonRepository } from '../repositories/seasons';
import { runtimeReleaseRevision } from '../utils/runtime-heartbeat';
import {
  recordFreshnessObservation,
  recordPendingLiveSnapshotCheckpointEvidence,
} from '../services/data-governance.service';
import {
  readLivePublicationV2Checkpoint,
  readLiveFinalizationPrerequisites,
} from '../services/live-publication-v2-checkpoint.service';
import { isTerminalJobFailure } from '../utils/worker-failure';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  deferSchedulerObligationForWorker,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../services/scheduler-obligation-lifecycle.service';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import {
  acknowledgeSupersededSchedulerLane,
  assertSchedulerLanePublicationFence,
  completeSchedulerLane,
  failSchedulerLane,
  fenceSchedulerLaneTarget,
  getSchedulerLaneTargets,
  retireSchedulerLaneForStaleSeason,
  startSchedulerLane,
} from '../repositories/scheduler-lanes';
import {
  createLiveSnapshotDatabaseBudget,
  getDatabaseHandleWithBudget,
  type LiveSnapshotDatabaseBudget,
} from '../utils/live-snapshot-db-budget';
import {
  LIVE_SNAPSHOT_DB_CHECKPOINT_WRITE_BUDGET_MS,
  LIVE_SNAPSHOT_DB_READ_BUDGET_MS,
} from '../domain/data-contracts';
import { ConflictError } from '../utils/errors';
import { retryPolicyForError, summarizeDataError } from '../domain/error-classification';

/**
 * Keep Bull delivery aligned with the durable scheduler retry policy. Bull's
 * queue-level `attempts` is a delivery safeguard; it must not turn a data or
 * contract failure into extra provider calls before the scheduler can record
 * the terminal classification.
 */
async function runLiveDataTrackedJob<T>(
  job: Job<LiveDataJobData>,
  laneScoped: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (laneScoped && !(error instanceof UnrecoverableError)) {
      const classified = summarizeDataError(error);
      const policy = retryPolicyForError(classified.errorClass);
      const deliveryAttempt = job.attemptsMade + 1;
      if (!policy.retryable || deliveryAttempt >= policy.maxAttempts) {
        // Keep the original typed error so scheduler failure handling retains
        // its DATA_INCOMPLETE/CONTRACT_DRIFT/provider classification. Bull
        // only needs the marker name to stop delivery retries; replacing the
        // error with a generic message would downgrade it to TRANSIENT_INFRA.
        if (error instanceof Error) {
          error.name = 'UnrecoverableError';
          throw error;
        }
        throw new UnrecoverableError(
          `${classified.errorClass}:${classified.errorCode} ${classified.summary}`,
        );
      }
    }
    throw error;
  }
}

function scheduledDueAtMsForLiveObligation(obligation: {
  dueAt: Date;
  evidence: Record<string, unknown>;
}): number {
  const raw = obligation.evidence.scheduledDueAtMs;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) return raw;
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const parsed = Number(raw);
    const date = new Date(parsed);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && Number.isFinite(date.getTime())) {
      return parsed;
    }
  }
  return obligation.dueAt.getTime();
}

function liveFreshnessWindowIdsForJob(
  jobData: Pick<LiveDataJobData, 'freshnessWindowId' | 'freshnessWindowIds'>,
  evidence?: unknown,
): number[] {
  const evidenceRecord =
    evidence && typeof evidence === 'object' && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : undefined;
  return [
    ...(Array.isArray(jobData.freshnessWindowIds) ? jobData.freshnessWindowIds : []),
    ...(Array.isArray(evidenceRecord?.freshnessWindowIds) ? evidenceRecord.freshnessWindowIds : []),
    jobData.freshnessWindowId,
    evidenceRecord?.freshnessWindowId,
  ].filter(
    (value, index, values): value is number =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      values.indexOf(value) === index,
  );
}

/**
 * A FINAL dependency wait is a successful Bull hand-off, not a successful
 * scheduler obligation. Keep the marker in the Bull return value so the
 * completion listener cannot turn the durable pending generation into a
 * false success after the worker has already performed its CAS defer.
 */
export function liveDataResultDeferredSchedulerObligation(
  jobName: string,
  result: unknown,
): boolean {
  if (jobName !== LIVE_JOBS.LIVE_SNAPSHOT) return false;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return (result as Record<string, unknown>).status === 'waiting-dependencies';
}

/**
 * Live Data Worker
 *
 * Processes live data sync jobs:
 * - live-snapshot: coherent upstream fetch + atomic Redis publication (30-sec)
 * - asynchronous V2 PostgreSQL checkpointing and the final-results cascade
 */
async function processLiveDataJob(job: Job<LiveDataJobData>) {
  const laneScoped = job.data.laneId !== undefined || job.data.laneGeneration !== undefined;
  return runLiveDataTrackedJob(job, laneScoped, () => processLiveDataJobInternal(job));
}

async function processLiveDataJobInternal(job: Job<LiveDataJobData>) {
  const usesLiveDatabaseBudget =
    job.name === LIVE_JOBS.LIVE_SNAPSHOT || job.name === LIVE_JOBS.LIVE_MATCH_CHECKPOINT;
  const databaseBudget: LiveSnapshotDatabaseBudget | null = usesLiveDatabaseBudget
    ? await createLiveSnapshotDatabaseBudget(
        job.name === LIVE_JOBS.LIVE_SNAPSHOT && job.data.finalizeEvent === true ? null : undefined,
      )
    : null;
  let freshnessWindowIds = liveFreshnessWindowIdsForJob(job.data);
  const hasLaneIdentity = job.data.laneId !== undefined || job.data.laneGeneration !== undefined;
  let laneIdentity:
    | {
        laneId: string;
        dispatchGeneration: number;
        activeObligationId: string;
        obligationGeneration: number;
        obligationDueAtMs: number;
      }
    | undefined;
  let liveLaneScopeKey: string | undefined;
  if (hasLaneIdentity) {
    const laneId = job.data.laneId;
    const laneGeneration = job.data.laneGeneration;
    if (!laneId || typeof laneGeneration !== 'number' || !Number.isSafeInteger(laneGeneration)) {
      throw new Error('Live snapshot job has an incomplete scheduler lane identity');
    }
    const startedLane = await startSchedulerLane({
      laneId,
      dispatchGeneration: laneGeneration,
      bullJobId: String(job.id),
      obligationId: job.data.obligationId,
      runId: job.data.runId,
      db: databaseBudget?.controlDb,
    });
    if (!startedLane) {
      logInfo('Skipping stale live snapshot lane before job execution', {
        queueName: job.queueName,
        jobName: job.name,
        jobId: job.id,
        laneId,
        laneGeneration,
      });
      return { skipped: true, staleSchedulerGeneration: true };
    }
    const fencedLane = await fenceSchedulerLaneTarget({
      laneId,
      dispatchGeneration: laneGeneration,
      activeObligationId: startedLane.obligation.obligationId,
      bullJobId: String(job.id),
      runId: job.data.runId,
      db: databaseBudget?.controlDb,
    });
    if (!fencedLane) {
      logInfo('Skipping live snapshot lane after target fence changed', {
        queueName: job.queueName,
        jobName: job.name,
        jobId: job.id,
        laneId,
        laneGeneration,
      });
      return { skipped: true, staleSchedulerGeneration: true };
    }
    if (!['pending', 'failed', 'enqueued', 'running'].includes(fencedLane.obligation.status)) {
      logInfo('Skipping terminal live snapshot lane target before provider execution', {
        queueName: job.queueName,
        jobName: job.name,
        jobId: job.id,
        laneId,
        laneGeneration,
        obligationId: fencedLane.obligation.obligationId,
        status: fencedLane.obligation.status,
      });
      return { skipped: true, staleSchedulerGeneration: true };
    }
    freshnessWindowIds = liveFreshnessWindowIdsForJob(job.data, fencedLane.obligation.evidence);
    laneIdentity = {
      laneId,
      dispatchGeneration: laneGeneration,
      activeObligationId: fencedLane.obligation.obligationId,
      obligationGeneration: fencedLane.obligation.generation,
      // `dueAt` is mutable retry state. Stage evidence must use the original
      // scheduled boundary so a deferred/retried obligation cannot make its
      // scheduler delay look artificially short.
      obligationDueAtMs: scheduledDueAtMsForLiveObligation(fencedLane.obligation),
    };
    if (job.name === LIVE_JOBS.LIVE_SNAPSHOT) {
      liveLaneScopeKey = fencedLane.obligation.scopeKey;
    }
    // The Bull payload can have been queued before a newer target became the
    // lane winner. Carry the fenced obligation identity into the normal
    // generation completion path; the event/scope itself remains unchanged.
    job.data.obligationId = fencedLane.obligation.obligationId;
    job.data.obligationGeneration = fencedLane.obligation.generation;
  } else if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
      db: databaseBudget?.controlDb,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }
  let season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>;
  try {
    season = await requireCurrentSeasonForJob(job.data, databaseBudget?.readDb);
  } catch (error) {
    // A scheduler lane can survive a season rollover while its Bull record is
    // still waiting. Terminalize that exact durable lane before the provider
    // stage; allowing the old-season FPL request would read current event IDs
    // under a historical publication scope. The scheduler performs the same
    // reconciliation on its next pass, while this worker closes the race when
    // it starts first.
    if (
      job.name === LIVE_JOBS.LIVE_SNAPSHOT &&
      laneIdentity &&
      liveLaneScopeKey === `${job.data.seasonCode}:event:${job.data.eventId}` &&
      error instanceof ConflictError &&
      error.code === 'STALE_JOB_SEASON'
    ) {
      const currentSeason = await createSeasonRepository(databaseBudget?.readDb).findCurrent();
      await retireSchedulerLaneForStaleSeason({
        laneId: laneIdentity.laneId,
        currentSeasonCode: currentSeason.seasonCode,
        db: databaseBudget?.controlDb,
      });
      logInfo('Skipped stale-season live snapshot lane before provider execution', {
        queueName: job.queueName,
        jobName: job.name,
        jobId: job.id,
        laneId: laneIdentity.laneId,
        laneGeneration: laneIdentity.dispatchGeneration,
        staleSeason: job.data.seasonCode,
        currentSeason: currentSeason.seasonCode,
      });
      return { skipped: true, staleSchedulerGeneration: true };
    }
    throw error;
  }
  const { eventId, source } = job.data;
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
    queueWaitMs:
      Number.isFinite(Number(job.timestamp)) && Number.isFinite(Number(job.processedOn))
        ? Math.max(0, Number(job.processedOn) - Number(job.timestamp))
        : null,
  };
  const schedulerDelayMs =
    laneIdentity && Number.isFinite(Number(job.timestamp))
      ? Math.max(0, Number(job.timestamp) - laneIdentity.obligationDueAtMs)
      : null;

  logJobTriggered(context);

  const result = await runTrackedJob(context, async () => {
    if (job.name === LIVE_JOBS.LIVE_FINAL_RETENTION) {
      const fence = inspectSchedulerObligationFence(job.data);
      if (fence.kind === 'malformed') {
        throw new Error(`Live final retention scheduler fence is malformed: ${fence.reason}`);
      }
      if (
        job.data.retentionRecoveryTarget &&
        (job.data.source !== 'manual' || fence.kind !== 'none')
      ) {
        throw new Error('Retention recovery requires an unfenced manual job');
      }
      if (job.data.retentionRecoveryTarget) {
        await assertManualLiveFinalRetentionRecoveryTarget({
          season,
          eventId,
          target: job.data.retentionRecoveryTarget,
        });
      }
      const result = await runLiveFinalRetentionV2(season, eventId, {
        authority:
          fence.kind === 'complete'
            ? {
                kind: 'scheduler',
                obligationId: fence.obligationId,
                generation: fence.generation,
              }
            : job.data.retentionRecoveryTarget
              ? { kind: 'manual-recovery', target: job.data.retentionRecoveryTarget }
              : { kind: 'manual-current' },
      });
      if (result.status !== 'succeeded') {
        throw new LiveFinalRetentionIncompleteError(result);
      }
      if (job.data.retentionRecoveryTarget) {
        await recordManualLiveFinalRetentionRecovery({
          season,
          eventId,
          target: job.data.retentionRecoveryTarget,
          result,
          jobId: String(job.id),
        });
      }
      return result;
    }
    if (job.name === LIVE_JOBS.LIVE_MATCH_CHECKPOINT) {
      if (!job.data.checkpointKind) {
        throw new Error('Live Match checkpoint job is missing checkpoint kind');
      }
      const result = await checkpointLiveMatchScopeV3({
        season,
        eventId,
        kind: job.data.checkpointKind,
        db: databaseBudget?.writeDb,
        allowFinalReplacement: job.data.checkpointAllowFinalReplacement === true,
      });
      // A failed or coalesced checkpoint leaves the Redis desired marker in
      // place for the periodic reconciler. Re-enqueue only after a successful
      // checkpoint, when a newer desired marker could have arrived during the
      // DB transaction. Calling this on every normal failure creates a zero-
      // delay successor loop that can starve live snapshot work for 24 hours.
      if (result.checkpointed) {
        await enqueueRemainingLiveMatchCheckpoint(season, eventId, job.data.checkpointKind);
      }
      return result;
    }
    if (job.name !== LIVE_JOBS.LIVE_SNAPSHOT) {
      throw new Error(`Unknown job name: ${job.name}`);
    }
    if (job.data.matchObservationOnly) {
      const result = await syncLiveMatchObservationV3(season, eventId, {
        lifecycleState: job.data.lifecycleState,
        expectedNextCheckAt: job.data.expectedNextCheckAt,
        databaseRead: databaseBudget?.readDb,
        // Preserve the broader scheduler decision explicitly: PICKS_PROBE is
        // normalized to the Match PRE_DEADLINE state for publication schema,
        // but it is post-deadline and may advance the eventless pointer.
        promoteActiveEvent: job.data.promoteActiveEvent === true,
      });
      if (result.checkpointObligationFailed) {
        throw new Error(`Live Match checkpoint obligation was not created for event ${eventId}`);
      }
      return result;
    }
    if (job.data.finalizeEvent === true) {
      const prerequisite = await readLiveFinalizationPrerequisites(
        season,
        eventId,
        databaseBudget?.readDb,
      );
      if (prerequisite.blocked) {
        const evidence = {
          finalization: 'waiting-for-entry-input',
          reason: 'DATA_INCOMPLETE:FINAL_ENTRY_INPUT_REQUIRES_PROVIDER_RECOVERY',
        };
        if (job.data.obligationId !== undefined && job.data.obligationGeneration !== undefined) {
          const deferred = await deferSchedulerObligationForWorker({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            dependencyWait: {
              reasonCodes: ['DATA_INCOMPLETE:FINAL_ENTRY_INPUT_REQUIRES_PROVIDER_RECOVERY'],
            },
            evidence,
            db: databaseBudget?.writeDb,
          });
          if (!deferred) throw new Error('Stale scheduler finalization preflight');
        } else {
          throw new Error(evidence.reason);
        }
        return { ...evidence, status: 'waiting-dependencies' as const };
      }
    }
    if (job.data.picksGateRequired === true) {
      const picksEvidence = await readLivePicksDurableFreshnessEvidence(
        season,
        eventId,
        databaseBudget?.readDb,
      ).catch(() => null);
      const picksComplete = Boolean(
        picksEvidence && (picksEvidence.expectedCount === 0 || picksEvidence.complete === true),
      );
      if (!picksComplete) {
        const evidence = {
          finalization: 'waiting-for-entry-picks',
          reason: 'DATA_INCOMPLETE:LIVE_PICKS_COHORT_INCOMPLETE',
          expectedCount: picksEvidence?.expectedCount ?? null,
          observedCount: picksEvidence?.observedCount ?? null,
        };
        if (job.data.obligationId !== undefined && job.data.obligationGeneration !== undefined) {
          const deferred = await deferSchedulerObligationForWorker({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            dependencyWait: {
              reasonCodes: [evidence.reason],
            },
            evidence,
            db: databaseBudget?.writeDb,
          });
          if (!deferred) throw new Error('Stale scheduler picks gate');
          return { ...evidence, status: 'waiting-dependencies' as const };
        }
        throw new Error(evidence.reason);
      }
    }
    if (job.data.bootstrapGateRequired === true) {
      const bootstrap = await ensureLiveBootstrapReady(season, eventId, new Date());
      if (bootstrap.status !== 'ready') {
        const evidence = {
          finalization: 'waiting-for-bootstrap',
          reason:
            bootstrap.status === 'unknown'
              ? 'SOURCE_NOT_READY:BOOTSTRAP_PROBE_UNKNOWN'
              : 'SOURCE_NOT_READY:BOOTSTRAP_HTTP_NOT_200',
          bootstrapStatus: bootstrap.status,
          bootstrapHttpStatus: bootstrap.httpStatus,
          bootstrapCheckedAt: bootstrap.checkedAt,
          bootstrapNextProbeAt: bootstrap.nextProbeAt,
        };
        if (job.data.obligationId !== undefined && job.data.obligationGeneration !== undefined) {
          const deferred = await deferSchedulerObligationForWorker({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            dependencyWait: {
              reasonCodes: [evidence.reason],
            },
            evidence,
            db: databaseBudget?.writeDb,
          });
          if (!deferred) throw new Error('Stale scheduler bootstrap gate');
        }
        return { ...evidence, status: 'waiting-dependencies' as const };
      }
    }
    const liveSnapshotStageStartedAt = Date.now();
    let snapshot: Awaited<ReturnType<typeof syncLiveSnapshotV2>>;
    try {
      const publicationLaneFence = laneIdentity;
      snapshot = await syncLiveSnapshotV2(season, eventId, {
        finalizeEvent: job.data.finalizeEvent === true,
        lifecycleState: job.data.lifecycleState,
        expectedNextCheckAt: job.data.expectedNextCheckAt,
        trigger: source,
        sourceRunId: job.data.runId,
        ...(databaseBudget ? { databaseBudget } : {}),
        ...(publicationLaneFence
          ? {
              schedulerLaneFence: publicationLaneFence,
              // Keep the durable lane row locked through Redis staging and
              // the active-pointer switch. Scheduler advancement therefore
              // cannot supersede this target in the gap between the provider
              // preflight and publication activation.
              withPublicationActivationFence: async <T>(activate: () => Promise<T>) => {
                const activationDb =
                  databaseBudget?.controlDb ??
                  (await getDatabaseHandleWithBudget(LIVE_SNAPSHOT_DB_READ_BUDGET_MS));
                return activationDb.transaction(async (tx) => {
                  await assertSchedulerLanePublicationFence(tx, publicationLaneFence);
                  return activate();
                });
              },
            }
          : {}),
      });
    } catch (error) {
      // A failed stage has no completed snapshot timings, but it still needs
      // one bounded record so timeout and provider failures are visible in
      // the same queue-wait/release/obligation vocabulary as successes.
      logError('Live snapshot stage failed', error, {
        releaseSha: runtimeReleaseRevision(),
        obligationId: job.data.obligationId,
        obligationGeneration: job.data.obligationGeneration,
        schedulerDelayMs,
        queueWaitMs: context.queueWaitMs,
        snapshotTotalMs: Math.max(0, Date.now() - liveSnapshotStageStartedAt),
        totalMs: Math.max(0, Date.now() - liveSnapshotStageStartedAt),
        eventId,
        budgetExceeded: ['stage-failed'],
      });
      throw error;
    }
    const budgetExceeded = [
      ...(snapshot.stageTimings.durableReadMs !== null &&
      snapshot.stageTimings.durableReadMs > LIVE_SNAPSHOT_DB_READ_BUDGET_MS
        ? ['database-read']
        : []),
      ...(snapshot.stageTimings.referenceReadMs !== null &&
      snapshot.stageTimings.referenceReadMs > LIVE_SNAPSHOT_DB_READ_BUDGET_MS
        ? ['reference-read']
        : []),
      ...(snapshot.stageTimings.fixtureIdentityReadMs !== null &&
      snapshot.stageTimings.fixtureIdentityReadMs > LIVE_SNAPSHOT_DB_READ_BUDGET_MS
        ? ['fixture-identity-read']
        : []),
      ...(snapshot.stageTimings.redisReadMs !== null &&
      snapshot.stageTimings.redisReadMs > LIVE_SNAPSHOT_DB_READ_BUDGET_MS
        ? ['redis-read']
        : []),
      ...(snapshot.stageTimings.redisPublishMs !== null &&
      snapshot.stageTimings.redisPublishMs > LIVE_SNAPSHOT_DB_READ_BUDGET_MS
        ? ['redis-publish']
        : []),
      ...(snapshot.stageTimings.checkpointMs !== null &&
      snapshot.stageTimings.checkpointMs > LIVE_SNAPSHOT_DB_CHECKPOINT_WRITE_BUDGET_MS
        ? ['checkpoint-write']
        : []),
      ...(job.data.finalizeEvent !== true && snapshot.stageTimings.totalMs > 90_000
        ? ['execution-total']
        : []),
    ];
    const stageSummary = {
      releaseSha: runtimeReleaseRevision(),
      obligationId: job.data.obligationId,
      obligationGeneration: job.data.obligationGeneration,
      schedulerDelayMs,
      queueWaitMs: context.queueWaitMs,
      controlReadMs: snapshot.stageTimings.controlReadMs,
      redisReadMs: snapshot.stageTimings.redisReadMs,
      durableReadMs: snapshot.stageTimings.durableReadMs,
      referenceReadMs: snapshot.stageTimings.referenceReadMs,
      fixtureIdentityReadMs: snapshot.stageTimings.fixtureIdentityReadMs,
      providerMs: snapshot.stageTimings.providerMs,
      redisPublishMs: snapshot.stageTimings.redisPublishMs,
      checkpointMs: snapshot.stageTimings.checkpointMs,
      snapshotTotalMs: snapshot.stageTimings.totalMs,
      totalMs: Math.max(0, Date.now() - liveSnapshotStageStartedAt),
      checkpointed: snapshot.checkpointed,
      publicationId: snapshot.publicationId,
      publicationGeneration: snapshot.generation,
      eventId,
      state: snapshot.state,
      budgetExceeded,
    };
    if (budgetExceeded.length > 0) {
      logWarn('Live snapshot stage exceeded budget', stageSummary);
    } else {
      logInfo('Live snapshot stage summary', stageSummary);
    }
    if (snapshot.checkpointObligationFailed) {
      throw new Error(`Live Match checkpoint obligation was not created for event ${eventId}`);
    }
    let liveLaneIsCurrent = true;
    if (laneIdentity) {
      try {
        // The execution budget may be exhausted by the provider/checkpoint.
        // Use a fresh bounded control read for the post-publication fence so a
        // successful snapshot is never converted into a retry merely because
        // its original 90-second handle has expired.
        const fenceDb = await getDatabaseHandleWithBudget(LIVE_SNAPSHOT_DB_READ_BUDGET_MS);
        const targets = await getSchedulerLaneTargets({ laneId: laneIdentity.laneId, db: fenceDb });
        if (targets) {
          freshnessWindowIds = [
            ...liveFreshnessWindowIdsForJob(job.data, targets.active?.evidence),
            ...liveFreshnessWindowIdsForJob(job.data, targets.desired?.evidence),
          ].filter((value, index, values) => values.indexOf(value) === index);
        }
        const lane = targets?.lane;
        liveLaneIsCurrent = Boolean(
          lane?.state === 'running' &&
            lane.dispatchGeneration === laneIdentity.dispatchGeneration &&
            lane.activeObligationId === laneIdentity.activeObligationId &&
            lane.desiredObligationId === laneIdentity.activeObligationId,
        );
      } catch (error) {
        // An unavailable fence is conservative for freshness evidence, but it
        // must not turn an otherwise successful publication into a Bull retry.
        liveLaneIsCurrent = false;
        logWarn('Live snapshot lane fence read failed after publication', {
          eventId,
          laneId: laneIdentity.laneId,
          dispatchGeneration: laneIdentity.dispatchGeneration,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!liveLaneIsCurrent) {
      logInfo('Live snapshot publication completed after lane target advanced', {
        eventId,
        jobId: job.id,
        laneId: laneIdentity?.laneId,
        dispatchGeneration: laneIdentity?.dispatchGeneration,
      });
    }
    // League boards are a sibling publication. A missing roster input or a
    // transient Redis/DB read must retain the last complete board and must not
    // turn a successful global live observation into a failed live job.
    let classicLeagueResult: Awaited<ReturnType<typeof syncLiveClassicLeaguePublicationsV2>> = null;
    try {
      classicLeagueResult = await syncLiveClassicLeaguePublicationsV2(
        season,
        eventId,
        job.data.expectedNextCheckAt,
        databaseBudget
          ? {
              databaseRead: databaseBudget.readDb,
              databaseReadClient: databaseBudget.readClient,
            }
          : undefined,
      );
    } catch (error) {
      logError(
        'Live Classic league publication pass failed; global publication is retained',
        error,
        {
          season: season.seasonCode,
          eventId,
        },
      );
    }
    let h2hLeagueResult: Awaited<ReturnType<typeof syncLiveH2HLeaguePublicationsV2>> = null;
    const averageReady = await ensureLiveAverageReadyForPublication(
      season,
      eventId,
      job.data.lifecycleState ?? snapshot.state,
    );
    if (!averageReady.ready) {
      logWarn('Live H2H publication is waiting for a fresh canonical Average Team score', {
        season: season.seasonCode,
        eventId,
        reason: averageReady.reason,
        sourceCheckedAt: averageReady.sourceCheckedAt,
      });
    } else {
      try {
        h2hLeagueResult = await syncLiveH2HLeaguePublicationsV2(
          season,
          eventId,
          job.data.expectedNextCheckAt,
          databaseBudget
            ? {
                databaseRead: databaseBudget.readDb,
                databaseReadClient: databaseBudget.readClient,
              }
            : undefined,
        );
      } catch (error) {
        logError('Live H2H league publication pass failed; global publication is retained', error, {
          season: season.seasonCode,
          eventId,
        });
      }
    }
    if (
      liveLaneIsCurrent &&
      freshnessWindowIds.length > 0 &&
      snapshot.publicationId !== null &&
      snapshot.generation !== null
    ) {
      const sourceCheckedAt = snapshot.sourceCheckedAt ? new Date(snapshot.sourceCheckedAt) : null;
      // A coalesced Redis publication can legitimately return
      // `checkpointed: false` even when the durable checkpoint already holds
      // the exact publication identity. Always read the checkpoint here; the
      // freshness window is scoped to the returned publication, not to the
      // boolean that says whether this invocation performed the checkpoint.
      const durableCheckpoint = await readLivePublicationV2Checkpoint(
        season,
        eventId,
        databaseBudget?.readDb,
      ).catch((error) => {
        logError('Live snapshot durable checkpoint read failed for freshness evidence', error, {
          eventId,
          windowIds: freshnessWindowIds,
        });
        return null;
      });
      const checkpoint = durableCheckpoint;
      const checkpointedAt = checkpoint?.publication.checkpointedAt;
      const pgPublishedAt = checkpointedAt ? new Date(checkpointedAt) : null;
      const checkpointMatchesSnapshot =
        checkpoint?.publication.publicationId === snapshot.publicationId &&
        checkpoint.publication.generation === snapshot.generation;
      const checkpointIsAheadOfSnapshot = Boolean(
        checkpoint &&
          (checkpoint.publication.generation > snapshot.generation ||
            (checkpoint.publication.generation === snapshot.generation &&
              checkpoint.publication.publicationId !== snapshot.publicationId)),
      );
      const validSourceCheckedAt =
        sourceCheckedAt !== null && Number.isFinite(sourceCheckedAt.getTime());
      const validPgPublishedAt = pgPublishedAt !== null && Number.isFinite(pgPublishedAt.getTime());
      const revision = `${snapshot.publicationId}:${snapshot.generation}`;
      const redisSeenAt = new Date();
      if (validSourceCheckedAt) {
        for (const windowId of freshnessWindowIds) {
          try {
            await recordFreshnessObservation({
              windowId,
              sourceCheckedAt,
              ...(checkpointMatchesSnapshot && validPgPublishedAt ? { pgPublishedAt } : {}),
              redisSeenAt,
              producerRevision: revision,
              redisRevision: revision,
              completenessStatus: 'COMPLETE',
              evidence: {
                liveCheckpointPending: !(checkpointMatchesSnapshot && validPgPublishedAt),
              },
              schedulerLaneFence: laneIdentity,
              db: databaseBudget?.writeDb,
            });
          } catch (error) {
            // Freshness telemetry is additive. The Redis publication and the
            // scheduler completion remain authoritative when the governance DB
            // is temporarily unavailable.
            logError('Live snapshot freshness evidence update failed', error, {
              eventId,
              windowId,
              publicationId: snapshot.publicationId,
            });
          }
        }
      }
      if (checkpointMatchesSnapshot && validSourceCheckedAt && validPgPublishedAt) {
        try {
          await recordPendingLiveSnapshotCheckpointEvidence({
            seasonId: season.seasonId,
            eventId,
            sourceCheckedAt,
            pgPublishedAt,
            redisSeenAt,
            revision,
            schedulerLaneFence: laneIdentity,
            db: databaseBudget?.writeDb,
          });
        } catch (error) {
          logError('Live snapshot pending freshness checkpoint reconciliation failed', error, {
            eventId,
            windowIds: freshnessWindowIds,
            publicationId: snapshot.publicationId,
          });
        }
      } else if (checkpoint && !checkpointMatchesSnapshot) {
        const context = {
          eventId,
          windowIds: freshnessWindowIds,
          snapshotPublicationId: snapshot.publicationId,
          snapshotGeneration: snapshot.generation,
          checkpointPublicationId: checkpoint.publication.publicationId,
          checkpointGeneration: checkpoint.publication.generation,
        };
        if (checkpointIsAheadOfSnapshot || snapshot.checkpointed) {
          // A durable checkpoint that is ahead of the Redis serving head, or
          // swaps publication identity at the same generation, is a real
          // ordering violation. A lower durable generation is expected only
          // for an uncheckpointed head inside the coalescing window; a Redis
          // checkpoint marker with missing durable evidence is an error too.
          logError(
            'Live snapshot freshness evidence checkpoint identity is inconsistent',
            new Error('live publication checkpoint ordering mismatch'),
            context,
          );
        } else {
          logDebug('Live snapshot freshness checkpoint remains pending after coalescing', context);
        }
      }
    }
    const classicGlobalIdentityMatches =
      classicLeagueResult?.globalPublicationId === snapshot.publicationId &&
      classicLeagueResult?.globalGeneration === snapshot.generation;
    const h2hGlobalIdentityMatches =
      h2hLeagueResult?.globalPublicationId === snapshot.publicationId &&
      h2hLeagueResult?.globalGeneration === snapshot.generation;
    const leagueFinalReady =
      snapshot.state === 'FINALIZED' &&
      classicGlobalIdentityMatches &&
      h2hGlobalIdentityMatches &&
      classicLeagueResult?.finalReady === true &&
      h2hLeagueResult?.finalReady === true;

    if (
      snapshot.state === 'FINALIZED' &&
      (!h2hGlobalIdentityMatches || !h2hLeagueResult?.finalReady)
    ) {
      // The official H2H final refresh is an explicit scheduler obligation
      // keyed by the event's data_checked boundary. Keeping the enqueue there
      // gives the H2H publication its own freshness window and avoids a
      // live-snapshot worker side channel with no scheduler evidence.
      logInfo('Finalized live publication is waiting for scheduled official H2H refresh', {
        season: season.seasonCode,
        eventId,
      });
    }

    if (snapshot.state === 'FINALIZED') {
      if (!snapshot.checkpointed) {
        throw new Error(
          `Finalized live publication is not durably checkpointed for event ${eventId}`,
        );
      }
      if (!leagueFinalReady) {
        logInfo('Finalized live publication is waiting for league finalization evidence', {
          season: season.seasonCode,
          eventId,
          globalIdentityMatches: classicGlobalIdentityMatches && h2hGlobalIdentityMatches,
          classicFinalReady: classicLeagueResult?.finalReady ?? false,
          h2hFinalReady: h2hLeagueResult?.finalReady ?? false,
        });
        if (job.data.obligationId !== undefined && job.data.obligationGeneration !== undefined) {
          const dependencyReasonCodes = [
            ...(classicLeagueResult?.finalReady === true ? [] : ['CLASSIC_LEAGUE_FINAL_NOT_READY']),
            ...(h2hLeagueResult?.finalReady === true ? [] : ['H2H_LEAGUE_FINAL_NOT_READY']),
          ];
          const deferred = await deferSchedulerObligationForWorker({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            dependencyWait: { reasonCodes: dependencyReasonCodes },
            evidence: {
              finalization: 'waiting-for-league-evidence',
              classicFinalReady: classicLeagueResult?.finalReady ?? false,
              h2hFinalReady: h2hLeagueResult?.finalReady ?? false,
            },
            db: databaseBudget?.writeDb,
          });
          if (!deferred) {
            throw new Error(
              `Live finalization obligation could not be deferred for event ${eventId}`,
            );
          }
        }
        return { ...snapshot, status: 'waiting-dependencies' as const };
      }
      // Final Match obligations are queued for normal recovery, but the final
      // snapshot must not race those jobs on this same two-slot worker before
      // it starts the downstream final-results cascade. Consume both exact
      // desired markers inline once; any duplicate queue jobs then observe an
      // already-cleared marker and become harmless no-ops.
      for (const kind of ['desk', 'detail'] as const) {
        await checkpointLiveMatchScopeV3({
          season,
          eventId,
          kind,
          db: databaseBudget?.writeDb,
          allowFinalReplacement: false,
        });
      }
      if (!(await hasFinalLiveMatchCheckpointsV3(season, eventId, databaseBudget?.readDb))) {
        throw new Error(
          `Finalized Live Matches desk/detail are not durably checkpointed for event ${eventId}`,
        );
      }
      await enqueueFinalLeagueResultsAfterLiveSync(season, eventId);
    }
    return snapshot;
  });
  if (laneIdentity) {
    if (laneIdentity.activeObligationId) {
      // The normal live execution budget may be exhausted by a provider or
      // checkpoint that finished right at its deadline. Lane completion is a
      // separate control-state transition and needs its own short, cancellable
      // handle; otherwise a successful snapshot can leave the lane stuck in
      // running until a later recovery pass notices it.
      const completionDb = await getDatabaseHandleWithBudget(LIVE_SNAPSHOT_DB_READ_BUDGET_MS);
      const completed = await completeSchedulerLane({
        laneId: laneIdentity.laneId,
        dispatchGeneration: laneIdentity.dispatchGeneration,
        activeObligationId: laneIdentity.activeObligationId,
        obligationGeneration: laneIdentity.obligationGeneration,
        status: 'succeeded',
        evidence: {
          queue: job.queueName,
          jobName: job.name,
          eventId: job.data.eventId,
          laneCompletion: 'live-snapshot',
        },
        db: completionDb,
      });
      if (!completed.ok) {
        logInfo('Live snapshot lane completion was fenced by a newer target', {
          laneId: laneIdentity.laneId,
          dispatchGeneration: laneIdentity.dispatchGeneration,
          activeObligationId: laneIdentity.activeObligationId,
        });
      }
    }
  }
  return result;
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
    if (liveDataResultDeferredSchedulerObligation(job.name, job.returnvalue)) return;
    if (job.id !== undefined) {
      // Latest-authoritative live snapshots settle their lane inside the
      // worker. A stale queued job still needs an explicit lane acknowledgement
      // so its Bull completion can release an enqueued generation without
      // acknowledging the skipped obligation as success.
      if (job.data.laneId !== undefined || job.data.laneGeneration !== undefined) {
        const laneGeneration = job.data.laneGeneration;
        if (
          job.data.laneId &&
          typeof laneGeneration === 'number' &&
          Number.isSafeInteger(laneGeneration) &&
          job.data.obligationId
        ) {
          void acknowledgeSupersededSchedulerLane({
            laneId: job.data.laneId,
            dispatchGeneration: laneGeneration,
            bullJobId: job.id,
            activeObligationId: job.data.obligationId,
          }).catch(() => false);
        }
        return;
      }
      const fence = inspectSchedulerObligationFence(job.data);
      const freshnessWindowIds = liveFreshnessWindowIdsForJob(job.data);
      const evidence = {
        queue: liveDataQueueName,
        jobName: job.name,
        eventId: job.data.eventId,
        ...(job.name === LIVE_JOBS.LIVE_FINAL_RETENTION && job.returnvalue
          ? {
              retentionPolicyVersion: job.returnvalue.policyVersion,
              retention: liveFinalRetentionCompletionEvidence(job.returnvalue),
            }
          : {}),
        ...(freshnessWindowIds.length === 0
          ? {}
          : {
              freshnessWindowId: freshnessWindowIds[0],
              freshnessWindowIds,
            }),
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
      if (job.data.laneId !== undefined || job.data.laneGeneration !== undefined) {
        const laneGeneration = job.data.laneGeneration;
        if (
          job.data.laneId &&
          typeof laneGeneration === 'number' &&
          Number.isSafeInteger(laneGeneration)
        ) {
          // Bull emits `failed` for every attempt. A retryable live snapshot
          // must keep the lane occupied until Bull exhausts its attempts;
          // releasing it here would let the scheduler dispatch a second
          // generation beside the retry that is already delayed/active.
          if (!isTerminalJobFailure(job, err)) return;
          // Use the identity carried by the failed payload. Reading the lane's
          // current active target first could select a newer obligation that
          // advanced while this old Bull callback was in flight; the exact
          // identity CAS below must reject that callback instead.
          const activeObligationId = job.data.obligationId;
          if (!activeObligationId) return;
          const laneId = job.data.laneId;
          void failSchedulerLane({
            laneId,
            dispatchGeneration: laneGeneration,
            activeObligationId,
            error: err,
          })
            .then((handled) =>
              handled
                ? true
                : acknowledgeSupersededSchedulerLane({
                    laneId,
                    dispatchGeneration: laneGeneration,
                    bullJobId: job.id ?? '',
                    activeObligationId,
                  }),
            )
            .catch(() => false);
        }
        return;
      }
      const fence = inspectSchedulerObligationFence(job.data);
      const failureEvidence =
        err instanceof LiveFinalRetentionIncompleteError
          ? {
              retentionPolicyVersion: err.evidence.policyVersion,
              retention: err.evidence,
            }
          : undefined;
      if (isTerminalJobFailure(job, err) && fence.kind === 'complete') {
        void failSchedulerObligation({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error: err,
          ...(failureEvidence ? { evidence: failureEvidence } : {}),
        }).catch(() => undefined);
      } else if (job.id !== undefined && isTerminalJobFailure(job, err) && fence.kind === 'none') {
        void failSchedulerObligationByBullJobId({
          bullJobId: job.id,
          error: err,
          ...(failureEvidence ? { evidence: failureEvidence } : {}),
        }).catch(() => undefined);
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
