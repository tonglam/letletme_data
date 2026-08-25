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
  failSchedulerLane,
  fenceSchedulerLaneTarget,
  getSchedulerLane,
  startSchedulerLane,
  unblockSchedulerLane,
  type SchedulerLaneTarget,
} from '../repositories/scheduler-lanes';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { syncOperationsRepository } from '../repositories/sync-operations';
import {
  preparePriceChangePublication,
  persistPriceChangePublication,
  PriceChangeCorePublicationRequiredError,
} from '../services/price-change-predictions.service';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import { readActiveDataPublication } from '../cache/data-publication';
import {
  resolveBullMqAttemptQueueWaitMs,
  runDataSyncAttempt,
  type DataSyncAttemptContext,
} from '../utils/data-sync-attempt';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
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

async function markSupersededPriceRunSkipped(
  target: SchedulerLaneTarget,
  job: Job<FplCriticalJobData>,
  skippedItems = 0,
): Promise<void> {
  const runId = target.obligation.runId ?? job.data.runId;
  if (!runId) return;
  await syncOperationsRepository
    .finishRun(runId, {
      status: 'skipped',
      completedItems: 0,
      skippedItems,
      dataChanged: false,
      metadata: { reason: 'superseded-by-latest-authoritative' },
    })
    .catch(() => undefined);
}

async function blockPriceLaneForCoreRepair(
  job: Job<FplCriticalJobData>,
  error: unknown,
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
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
  });
  if (!blocked) throw new Error('Price lane blocker CAS failed');

  try {
    const repair = await enqueueFplCriticalCoreRepairJob(season, 'reconcile', {
      jobId: `core-snapshot-price-change-repair-${laneId}-g${dispatchGeneration}`,
      removeOnSettle: false,
      laneId,
      laneGeneration: dispatchGeneration,
      blockerLaneId: laneId,
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
    await unblockSchedulerLane({
      blockerJobId: repairId,
      success: false,
      error: repairError,
    }).catch(() => undefined);
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
      prepared = await preparePriceChangePublication(
        season,
        undefined,
        job.data.source === 'manual' ? 'manual' : 'queue',
      );
    } catch (error) {
      if (error instanceof PriceChangeCorePublicationRequiredError) {
        return blockPriceLaneForCoreRepair(job, error, season);
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
    const beforePersist = await fenceSchedulerLaneTarget({
      laneId,
      dispatchGeneration,
      activeObligationId: activeTarget.obligation.obligationId,
      bullJobId: String(job.id),
      runId: job.data.runId,
    });
    if (!beforePersist) throw new Error('Scheduler lane pre-publication fence CAS failed');
    if (beforePersist.obligation.obligationId !== activeTarget.obligation.obligationId) {
      await markSupersededPriceRunSkipped(
        activeTarget,
        job,
        prepared.outcome === 'ready' ? prepared.board.players.length : 0,
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
        return blockPriceLaneForCoreRepair(job, error, season);
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
  const blockerId = String(job.id);
  const result = await withMutationScopes(
    {
      queueName: fplCriticalSyncQueueName,
      jobName: job.name,
      jobId: blockerId,
    },
    () => syncCoreSnapshot(season, { trigger: 'queue' }),
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
      const lane = getSchedulerLane({ laneId: job.data.laneId });
      const activeObligationId = (await lane)?.activeObligationId;
      if (activeObligationId) {
        await failSchedulerLane({
          laneId: job.data.laneId,
          dispatchGeneration: job.data.laneGeneration,
          activeObligationId,
          error,
        });
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
