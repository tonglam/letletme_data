import { QueueEvents, Worker, type Job } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { enqueueFplCriticalCoreRepairJob } from '../jobs/fpl-critical-sync-enqueue';
import {
  fplCriticalSyncQueue,
  fplCriticalSyncQueueName,
  type FplCriticalJobData,
} from '../queues/fpl-critical-sync.queue';
import {
  blockSchedulerLane,
  completeSchedulerLane,
  fenceSchedulerLaneTarget,
  getSchedulerLane,
  recoverSchedulerLaneAfterBullLoss,
  startSchedulerLane,
  unblockSchedulerLane,
  type SchedulerLaneTarget,
  getSchedulerLaneTargets,
} from '../repositories/scheduler-lanes';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { syncOperationsRepository } from '../repositories/sync-operations';
import {
  preparePriceChangePublication,
  persistPriceChangePublication,
  PriceChangeCorePublicationRequiredError,
} from '../services/price-change-predictions.service';
import {
  loadPriceChangeHotSource,
  markPriceChangeHotReconciliation,
  readPriceChangeHotSnapshot,
  readPriceChangeHotSnapshotAtRevision,
} from '../services/price-change-hot.service';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import { readActiveDataPublication } from '../cache/data-publication';
import {
  resolveBullMqAttemptQueueWaitMs,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo, logWarn } from '../utils/logger';
import { alertOnFinalFailure, notifyTwoBots } from '../utils/notify';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { withMutationScopes } from '../utils/mutation-scopes';
import type { WorkerRuntime } from './worker-runtime';

const MAX_TARGETS_PER_DISPATCH = 2;

function laneInputs(job: Job<FplCriticalJobData>): {
  laneId: string;
  dispatchGeneration: number;
} {
  if (!job.data.laneId || !Number.isSafeInteger(job.data.laneGeneration)) {
    throw new Error(`${job.name} job is missing its scheduler lane identity`);
  }
  return { laneId: job.data.laneId, dispatchGeneration: job.data.laneGeneration };
}

function blockerJobId(seasonCode: string, laneId: string, generation: number): string {
  return `${seasonCode}-core-snapshot-price-change-repair-${laneId}-g${generation}`;
}

type HotPriceSourceMetadata = Readonly<{
  sourceHash?: string;
  sourceArtifactId?: string;
  priceChangeBoardRevision?: string;
  sourceDetectedAt?: string;
  sourceFetchedAt?: string;
}>;

function hotPriceSourceMetadata(
  job: Job<FplCriticalJobData>,
  evidence?: Record<string, unknown>,
): HotPriceSourceMetadata {
  const sourceHash =
    (typeof evidence?.sourceHash === 'string' ? evidence.sourceHash : undefined) ??
    job.data.sourceHash;
  const sourceArtifactId =
    (typeof evidence?.sourceArtifactId === 'string' ? evidence.sourceArtifactId : undefined) ??
    job.data.sourceArtifactId;
  const priceChangeBoardRevision =
    (typeof evidence?.priceChangeBoardRevision === 'string'
      ? evidence.priceChangeBoardRevision
      : undefined) ?? job.data.priceChangeBoardRevision;
  const sourceDetectedAt =
    (typeof evidence?.sourceDetectedAt === 'string' ? evidence.sourceDetectedAt : undefined) ??
    job.data.sourceDetectedAt;
  const sourceFetchedAt =
    (typeof evidence?.sourceFetchedAt === 'string' ? evidence.sourceFetchedAt : undefined) ??
    job.data.sourceFetchedAt;
  return {
    sourceHash,
    sourceArtifactId,
    priceChangeBoardRevision,
    sourceDetectedAt,
    sourceFetchedAt,
  };
}

function sameHotPriceSource(left: HotPriceSourceMetadata, right: HotPriceSourceMetadata): boolean {
  return (
    left.sourceHash === right.sourceHash &&
    left.sourceArtifactId === right.sourceArtifactId &&
    left.priceChangeBoardRevision === right.priceChangeBoardRevision &&
    left.sourceDetectedAt === right.sourceDetectedAt &&
    left.sourceFetchedAt === right.sourceFetchedAt
  );
}

function captureTimestampsFromMetadata(
  metadata: HotPriceSourceMetadata,
): { readonly requestStartedAt: Date; readonly fetchedAt: Date } | null {
  if (!metadata.sourceDetectedAt && !metadata.sourceFetchedAt) return null;
  if (!metadata.sourceDetectedAt || !metadata.sourceFetchedAt) {
    throw new Error('Archived price-change source capture timestamps are incomplete');
  }
  const requestStartedAt = new Date(metadata.sourceDetectedAt);
  const fetchedAt = new Date(metadata.sourceFetchedAt);
  if (!Number.isFinite(requestStartedAt.getTime()) || !Number.isFinite(fetchedAt.getTime())) {
    throw new Error('Archived price-change source capture timestamps are invalid');
  }
  return { requestStartedAt, fetchedAt };
}

async function hotPriceSourceDependencies(
  job: Job<FplCriticalJobData>,
  metadata: HotPriceSourceMetadata = hotPriceSourceMetadata(job),
) {
  if (!metadata.sourceArtifactId || !metadata.sourceHash) return undefined;
  try {
    const hotSnapshot = metadata.priceChangeBoardRevision
      ? await readPriceChangeHotSnapshotAtRevision(
          job.data.seasonCode,
          metadata.priceChangeBoardRevision,
        ).catch(() => null)
      : await readPriceChangeHotSnapshot(job.data.seasonCode).catch(() => null);
    const source = await loadPriceChangeHotSource({
      artifactId: metadata.sourceArtifactId,
      sourceHash: metadata.sourceHash,
    });
    logInfo('Using archived provisional source for critical price reconciliation', {
      season: job.data.seasonCode,
      artifactId: metadata.sourceArtifactId,
      sourceHash: metadata.sourceHash,
      priceChangeBoardRevision: metadata.priceChangeBoardRevision,
    });
    const capturedAt =
      hotSnapshot !== null &&
      hotSnapshot.sourceHash === metadata.sourceHash &&
      (!metadata.priceChangeBoardRevision ||
        hotSnapshot.revision === metadata.priceChangeBoardRevision)
        ? {
            requestStartedAt: new Date(hotSnapshot.detectedAt),
            fetchedAt: new Date(hotSnapshot.fetchedAt),
          }
        : captureTimestampsFromMetadata(metadata);
    return {
      bootstrap: source.payload,
      getBootstrap: async () => source.payload,
      ...(capturedAt
        ? {
            captureTimestamps: {
              requestStartedAt: capturedAt.requestStartedAt,
              fetchedAt: capturedAt.fetchedAt,
            },
          }
        : {}),
    };
  } catch (error) {
    logWarn(
      'Archived provisional source unavailable; critical price reconciliation will re-fetch',
      {
        season: job.data.seasonCode,
        artifactId: metadata.sourceArtifactId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }
}

async function markHotPriceReconciled(
  job: Job<FplCriticalJobData>,
  publicationId: string | undefined,
  revision: number | undefined,
  preparedBoardRevision?: string,
  metadata: HotPriceSourceMetadata = hotPriceSourceMetadata(job),
): Promise<void> {
  if (!metadata.priceChangeBoardRevision || !publicationId || revision === undefined) return;
  const snapshot = await readPriceChangeHotSnapshotAtRevision(
    job.data.seasonCode,
    metadata.priceChangeBoardRevision,
  ).catch(() => null);
  if (!snapshot || snapshot.revision !== metadata.priceChangeBoardRevision) return;
  if (preparedBoardRevision !== metadata.priceChangeBoardRevision) return;
  const updated = await markPriceChangeHotReconciliation(snapshot, {
    state: 'reconciled',
    durablePublicationId: publicationId,
    durableRevision: revision,
  });
  if (!updated) throw new Error('Price-change hot reconciliation CAS failed');
}

async function markHotPriceReconciliationFailed(
  job: Job<FplCriticalJobData>,
  error: unknown,
): Promise<void> {
  // A latest-wins worker can fail after its Bull payload was superseded. Read
  // the lane's active target first so the terminal callback marks the current
  // hot revision failed rather than leaving that newer snapshot pending.
  const targets = job.data.laneId
    ? await getSchedulerLaneTargets({ laneId: job.data.laneId }).catch(() => null)
    : null;
  const metadata = hotPriceSourceMetadata(
    job,
    targets?.active?.evidence ?? targets?.desired?.evidence,
  );
  if (!metadata.priceChangeBoardRevision) return;
  const snapshot = await readPriceChangeHotSnapshotAtRevision(
    job.data.seasonCode,
    metadata.priceChangeBoardRevision,
  ).catch(() => null);
  if (!snapshot || snapshot.revision !== metadata.priceChangeBoardRevision) return;
  const updated = await markPriceChangeHotReconciliation(snapshot, {
    state: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
  if (!updated) throw new Error('Price-change hot reconciliation failure CAS failed');
}

async function markSupersededPriceRunSkipped(
  target: SchedulerLaneTarget,
  job: Job<FplCriticalJobData>,
  skippedItems = 0,
  runIdOverride?: string,
  strict = false,
): Promise<void> {
  const runId = runIdOverride ?? target.obligation.runId ?? job.data.runId;
  if (!runId) return;
  const finish = syncOperationsRepository.finishRun(runId, {
    status: 'skipped',
    completedItems: 0,
    skippedItems,
    dataChanged: false,
    metadata: { reason: 'superseded-by-latest-authoritative' },
  });
  if (strict) {
    await finish;
  } else {
    // The lane's scheduler job run ID is only a correlation identifier; older
    // producers did not create a sync_runs row for it. Keep that compatibility
    // path best-effort while requiring the real preparation run below.
    await finish.catch(() => undefined);
  }
}

async function blockPriceLaneForCoreRepair(
  job: Job<FplCriticalJobData>,
  error: unknown,
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
  metadata: HotPriceSourceMetadata = hotPriceSourceMetadata(job),
): Promise<{ outcome: 'blocked'; blockerJobId: string }> {
  const { laneId, dispatchGeneration } = laneInputs(job);
  const lane = await getSchedulerLane({ laneId });
  const activeObligationId = lane?.activeObligationId;
  if (!activeObligationId) throw new Error('Price lane has no active obligation to block');
  const repairId = blockerJobId(season.seasonCode, laneId, dispatchGeneration);
  const blocked = await blockSchedulerLane({
    laneId,
    dispatchGeneration,
    activeObligationId,
    blockerJobId: repairId,
    error,
    blockerEvidence: {
      ...metadata,
      sourceArtifactId: metadata.sourceArtifactId,
      sourceHash: metadata.sourceHash,
      priceChangeBoardRevision: metadata.priceChangeBoardRevision,
      sourceDetectedAt: metadata.sourceDetectedAt,
      sourceFetchedAt: metadata.sourceFetchedAt,
    },
  });
  if (!blocked) throw new Error('Price lane blocker CAS failed');

  try {
    const repair = await enqueueFplCriticalCoreRepairJob(season, 'reconcile', {
      jobId: `core-snapshot-price-change-repair-${laneId}-g${dispatchGeneration}`,
      removeOnSettle: false,
      laneId,
      laneGeneration: dispatchGeneration,
      blockerLaneId: laneId,
      ...(metadata.sourceHash ? { sourceHash: metadata.sourceHash } : {}),
      ...(metadata.sourceArtifactId ? { sourceArtifactId: metadata.sourceArtifactId } : {}),
      ...(metadata.priceChangeBoardRevision
        ? { priceChangeBoardRevision: metadata.priceChangeBoardRevision }
        : {}),
      ...(metadata.sourceDetectedAt ? { sourceDetectedAt: metadata.sourceDetectedAt } : {}),
      ...(metadata.sourceFetchedAt ? { sourceFetchedAt: metadata.sourceFetchedAt } : {}),
    });
    if (String(repair.id) !== repairId) {
      throw new Error(`Core repair Bull ID mismatch: expected ${repairId}, got ${repair.id}`);
    }
    logInfo('Price lane blocked for Core repair', {
      laneId,
      dispatchGeneration,
      blockerJobId: repairId,
      season: season.seasonCode,
    });
  } catch (repairError) {
    // Keep the lane blocked until the deterministic repair delivery is
    // reconciled. The process may exit after blockSchedulerLane commits but
    // before Queue.add returns (or after Bull accepts the job and the response
    // is lost); unblocking here would allow a second price generation to run
    // while Core is still stale. The scheduler reconciles blockerJobId against
    // Bull and either re-adds the missing repair or releases the lane with the
    // five-minute retry delay after a confirmed failure.
    await notifyTwoBots(
      [
        'Price-change Core repair enqueue failed',
        `Season: ${season.seasonCode}`,
        `Lane: ${laneId}`,
        `Error: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
      ].join('\n'),
      { idempotencyKey: `price-core-repair-enqueue:${repairId}` },
    ).catch(() => undefined);
    throw repairError;
  }
  return { outcome: 'blocked', blockerJobId: repairId };
}

async function verifyPricePublication(
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
  publicationId: string,
  revision: number,
): Promise<void> {
  const delivered = await dispatchDataPublicationOutbox({ limit: 1, publicationId });
  if (delivered.delivered !== 1) {
    const active = await readActiveDataPublication({
      dataset: 'fpl:price-changes',
      seasonCode: season.seasonCode,
    });
    if (active?.manifest.publicationId !== publicationId || active.manifest.revision !== revision) {
      throw new Error(
        `Price-change publication ${publicationId} is canonical but Redis delivery is pending`,
      );
    }
  }
  const active = await readActiveDataPublication({
    dataset: 'fpl:price-changes',
    seasonCode: season.seasonCode,
  });
  if (active?.manifest.publicationId !== publicationId || active.manifest.revision !== revision) {
    throw new Error('Price-change DB and Redis publication identities do not match');
  }
}

async function processPriceChangeJob(job: Job<FplCriticalJobData>) {
  const season = await requireCurrentSeasonForJob(job.data);
  const { laneId, dispatchGeneration } = laneInputs(job);
  const lane = await getSchedulerLane({ laneId });
  if (!lane) throw new Error(`Scheduler lane ${laneId} does not exist`);
  if (lane.state === 'blocked') return { outcome: 'already-blocked' as const };
  const started = await startSchedulerLane({
    laneId,
    dispatchGeneration,
    bullJobId: String(job.id),
    runId: job.data.runId,
  });
  if (!started) throw new Error('Scheduler lane start CAS failed');

  let activeTarget = started;
  for (let processed = 0; processed < MAX_TARGETS_PER_DISPATCH; processed += 1) {
    const previousTarget = activeTarget;
    const target = await fenceSchedulerLaneTarget({
      laneId,
      dispatchGeneration,
      activeObligationId: activeTarget.obligation.obligationId,
      bullJobId: String(job.id),
      runId: job.data.runId,
    });
    if (!target) throw new Error('Scheduler lane target fence CAS failed');
    if (target.obligation.obligationId !== previousTarget.obligation.obligationId) {
      await markSupersededPriceRunSkipped(previousTarget, job);
    }
    activeTarget = target;

    let prepared;
    try {
      const freshnessWindowIds = [
        ...(Array.isArray(job.data.freshnessWindowIds) ? job.data.freshnessWindowIds : []),
        ...(Array.isArray(activeTarget.obligation.evidence.freshnessWindowIds)
          ? activeTarget.obligation.evidence.freshnessWindowIds
          : []),
        job.data.freshnessWindowId,
        activeTarget.obligation.evidence.freshnessWindowId,
      ].filter(
        (value, index, values): value is number =>
          typeof value === 'number' &&
          Number.isSafeInteger(value) &&
          value > 0 &&
          values.indexOf(value) === index,
      );
      const freshnessWindowId = freshnessWindowIds[0];
      const sourceMetadata = hotPriceSourceMetadata(job, activeTarget.obligation.evidence);
      const hotSource = await hotPriceSourceDependencies(job, sourceMetadata);
      prepared = await preparePriceChangePublication(
        season,
        hotSource,
        job.data.source === 'manual' ? 'manual' : 'queue',
        job.data.runId,
        freshnessWindowId,
        freshnessWindowIds,
      );
    } catch (error) {
      if (error instanceof PriceChangeCorePublicationRequiredError) {
        return blockPriceLaneForCoreRepair(
          job,
          error,
          season,
          hotPriceSourceMetadata(job, activeTarget.obligation.evidence),
        );
      }
      throw error;
    }
    if (prepared.outcome === 'noop') {
      const completed = await completeSchedulerLane({
        laneId,
        dispatchGeneration,
        activeObligationId: activeTarget.obligation.obligationId,
        status: 'skipped',
        evidence: { reason: prepared.reason },
      });
      if (!completed.ok) throw new Error('Scheduler lane noop completion CAS failed');
      return { outcome: 'noop' as const };
    }

    // Re-read the desired target immediately before publication. If a newer
    // five-minute obligation arrived while the HTTP request was in flight,
    // discard this payload and let the same Bull job prepare the latest one.
    let beforePersist: SchedulerLaneTarget | null;
    try {
      beforePersist = await fenceSchedulerLaneTarget({
        laneId,
        dispatchGeneration,
        activeObligationId: activeTarget.obligation.obligationId,
        bullJobId: String(job.id),
        runId: job.data.runId,
      });
      if (!beforePersist) throw new Error('Scheduler lane pre-publication fence CAS failed');
    } catch (error) {
      // preparePriceChangePublication creates its own RUNNING source run. A
      // fence exception (including a null CAS) happens after preparation's
      // error handler has returned, so close that run here before allowing Bull
      // to retry. Otherwise every retry leaves a non-terminal sync_runs row and
      // the deployment quiescence gate can never drain.
      await syncOperationsRepository.failRun(prepared.sourceRunId, error);
      throw error;
    }
    const preparedSource = hotPriceSourceMetadata(job, activeTarget.obligation.evidence);
    const currentSource = hotPriceSourceMetadata(job, beforePersist.obligation.evidence);
    const targetChanged =
      beforePersist.obligation.obligationId !== activeTarget.obligation.obligationId;
    const sourceChanged = !sameHotPriceSource(preparedSource, currentSource);
    if (targetChanged || sourceChanged) {
      const skippedItems = prepared.outcome === 'ready' ? prepared.board.players.length : 0;
      if (targetChanged) await markSupersededPriceRunSkipped(activeTarget, job, skippedItems);
      // preparePriceChangePublication owns a separate source run for the HTTP
      // fetch. Retire that run too; otherwise a superseded fetch remains
      // RUNNING forever and blocks the deployment quiescence gate. A source
      // evidence update can keep the same obligation ID, so this check must
      // also retire and re-prepare when only the captured revision/hash changed.
      await markSupersededPriceRunSkipped(
        activeTarget,
        job,
        skippedItems,
        prepared.sourceRunId,
        true,
      );
      activeTarget = beforePersist;
      continue;
    }

    let persisted;
    try {
      persisted = await withMutationScopes(
        {
          queueName: fplCriticalSyncQueueName,
          jobName: job.name,
          jobId: String(job.id),
        },
        () =>
          persistPriceChangePublication(prepared, {
            deferDelivery: true,
            publicationFence: {
              laneId,
              dispatchGeneration,
              activeObligationId: activeTarget.obligation.obligationId,
            },
          }),
      );
    } catch (error) {
      await syncOperationsRepository.failRun(prepared.sourceRunId, error).catch(() => undefined);
      if (error instanceof PriceChangeCorePublicationRequiredError) {
        return blockPriceLaneForCoreRepair(
          job,
          error,
          season,
          hotPriceSourceMetadata(job, activeTarget.obligation.evidence),
        );
      }
      if (
        error instanceof Error &&
        error.message.includes('Scheduler lane target was superseded') &&
        processed + 1 < MAX_TARGETS_PER_DISPATCH
      ) {
        const latest = await getSchedulerLane({ laneId });
        if (latest?.activeObligationId) {
          activeTarget = {
            lane: latest,
            obligation: {
              ...activeTarget.obligation,
              obligationId: latest.activeObligationId,
            },
          };
          continue;
        }
      }
      throw error;
    }
    if (!persisted.publicationId || persisted.revision === undefined) {
      throw new Error('Price-change publication did not return durable identity');
    }
    await verifyPricePublication(season, persisted.publicationId, persisted.revision);
    await markHotPriceReconciled(
      job,
      persisted.publicationId,
      persisted.revision,
      prepared.board.revision,
      hotPriceSourceMetadata(job, activeTarget.obligation.evidence),
    );
    const completed = await completeSchedulerLane({
      laneId,
      dispatchGeneration,
      activeObligationId: activeTarget.obligation.obligationId,
      status: 'succeeded',
      evidence: {
        publicationId: persisted.publicationId,
        revision: persisted.revision,
        fetchedAt: persisted.fetchedAt,
      },
    });
    if (!completed.ok) throw new Error('Scheduler lane completion CAS failed');
    return persisted;
  }
  throw new Error('Price-change lane exceeded its bounded target dispatch');
}

async function processCoreRepairJob(job: Job<FplCriticalJobData>) {
  const season = await requireCurrentSeasonForJob(job.data);
  const { laneId, dispatchGeneration } = laneInputs(job);
  const hotSource = await hotPriceSourceDependencies(job);
  const blockerId = String(job.id);
  const result = await withMutationScopes(
    {
      queueName: fplCriticalSyncQueueName,
      jobName: job.name,
      jobId: blockerId,
    },
    () =>
      syncCoreSnapshot(season, {
        trigger: 'queue',
        sourceRunId: job.data.runId,
        ...(hotSource?.bootstrap ? { bootstrap: hotSource.bootstrap } : {}),
        ...(hotSource?.captureTimestamps?.requestStartedAt
          ? { sourceCheckedAt: hotSource.captureTimestamps.requestStartedAt }
          : {}),
      }),
  );
  if (result.outcome !== 'ready' || !result.publicationId || result.revision === undefined) {
    throw new Error('Core repair did not produce a durable publication');
  }
  const unblocked = await unblockSchedulerLane({ blockerJobId: blockerId, success: true });
  if (!unblocked) throw new Error('Scheduler lane unblock CAS failed');
  logInfo('Core repair unblocked price lane', {
    laneId,
    dispatchGeneration,
    blockerJobId: blockerId,
    publicationId: result.publicationId,
    revision: result.revision,
  });
  return result;
}

async function processCriticalJob(job: Job<FplCriticalJobData>) {
  const context = {
    jobType: 'queue' as const,
    queueName: fplCriticalSyncQueueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data.source,
    attempt: job.attemptsMade + 1,
    queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
  };
  const attemptContext: DataSyncAttemptContext = {
    queue: fplCriticalSyncQueueName,
    jobName: job.name,
    runId: job.data.runId ?? String(job.id ?? `${job.name}-${job.timestamp}`),
    source: job.data.source,
    attempt: job.attemptsMade + 1,
    queueWaitMs: context.queueWaitMs,
  };
  logJobTriggered(context);
  return runDataSyncAttempt(attemptContext, () =>
    runTrackedJob(context, async () => {
      if (job.name === 'price-change-predictions') return processPriceChangeJob(job);
      if (job.name === 'core-snapshot-price-change-repair') return processCoreRepairJob(job);
      throw new Error(`Unknown fpl-critical-sync job: ${job.name}`);
    }),
  );
}

export function createFplCriticalSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<FplCriticalJobData>(fplCriticalSyncQueueName, processCriticalJob, {
    connection,
    concurrency: 1,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(fplCriticalSyncQueueName, { connection });

  worker.on('completed', (job, result) => {
    logInfo('FPL critical sync job completed', {
      queue: fplCriticalSyncQueueName,
      jobId: job.id,
      name: job.name,
      outcome:
        result && typeof result === 'object' && 'outcome' in result ? result.outcome : 'ready',
    });
  });

  worker.on('failed', (job, error) => {
    if (!job) return;
    logError('FPL critical sync job failed', error, {
      queue: fplCriticalSyncQueueName,
      jobId: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
    });
    void alertOnFinalFailure(job, error);
    if (!isTerminalJobFailure(job, error)) return;
    void (async () => {
      await markHotPriceReconciliationFailed(job, error).catch((reconciliationError) => {
        logError('Price-change hot reconciliation failure update failed', reconciliationError, {
          jobId: job.id,
          season: job.data.seasonCode,
        });
      });
      if (job.name === 'core-snapshot-price-change-repair') {
        const unblocked = await unblockSchedulerLane({
          blockerJobId: String(job.id),
          success: false,
          error,
        });
        if (!unblocked) throw new Error('Core repair failure unblock CAS failed');
        await notifyTwoBots(
          [
            'Price-change Core repair failed',
            `Season: ${job.data.seasonCode}`,
            `Lane: ${job.data.laneId}`,
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          ].join('\n'),
          { idempotencyKey: `price-core-repair-failed:${job.id}` },
        );
        return;
      }
      const recovered = await recoverSchedulerLaneAfterBullLoss({
        laneId: job.data.laneId,
        dispatchGeneration: job.data.laneGeneration,
        bullJobId: String(job.id),
        bullState: 'failed',
        obligationId: job.data.obligationId,
      });
      if (!recovered) {
        // A false CAS means another generation already owns the lane (or the
        // row was retired). Surface it in logs instead of silently ignoring a
        // terminal callback; stale callbacks must remain observable.
        throw new Error(
          `Price lane failure reconciliation CAS failed for ${job.data.laneId} generation ${job.data.laneGeneration}`,
        );
      }
    })().catch((failure) => logError('FPL critical failure reconciliation failed', failure));
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [
      { queue: fplCriticalSyncQueue, queueEvents, queueName: fplCriticalSyncQueueName },
    ],
  };
}
