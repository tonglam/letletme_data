import { QueueEvents, Worker, type Job } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { fplClient } from '../clients/fpl';
import { enqueueCoreSnapshotJob, enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import { type DataSyncJobData, dataSyncQueue, dataSyncQueueName } from '../queues/data-sync.queue';
import { syncPlayerPricesForDate } from '../services/player-prices.service';
import { syncCurrentPlayerStats, syncPlayerStatsForEvent } from '../services/player-stats.service';
import {
  persistPreparedPlayerValuesSync,
  preparePlayerValuesSync,
} from '../services/player-values.service';
import { ensureMarketPublication } from '../services/market-publication.service';
import { readActiveDataPublication } from '../cache/data-publication';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { syncCoreSnapshot } from '../services/core-snapshot.service';
import {
  preparePriceChangePublication,
  persistPriceChangePublication,
  PriceChangeCorePublicationRequiredError,
  priceChangeTriggerFingerprint,
} from '../services/price-change-predictions.service';
import {
  loadPriceChangeHotSource,
  markPriceChangeHotReconciliation,
  readPriceChangeHotSnapshot,
  readPriceChangeHotSnapshotAtRevision,
} from '../services/price-change-hot.service';
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
import { formatCronDateKey } from '../utils/timezone';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import type { WorkerRuntime } from './worker-runtime';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
  getSchedulerObligation,
  schedulerObligationStatus,
} from '../repositories/scheduler-obligations';

function priceChangeCoreRepairJobId(job: Job<DataSyncJobData>): string {
  // Keep one repair per price-change attempt, not one repair forever.  The
  // logical run ID is stable across Bull retries, while attemptsMade changes
  // when a completed repair must be requested again after another mismatch.
  const runId = job.data.runId ?? String(job.id ?? job.timestamp);
  return `core-snapshot-price-change-repair-${runId}-attempt-${job.attemptsMade + 1}`;
}

function priceSingleFlightEnabled(): boolean {
  const value = process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED;
  // Keep the legacy worker's default aligned with the scheduler registry and
  // publication reconciler: local/test processes opt into the lane unless an
  // explicit flag says otherwise, while production remains opt-in during the
  // staged rollout.
  if (value === undefined) return process.env.NODE_ENV !== 'production';
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function archivedCaptureTimestamps(
  sourceDetectedAt: string | undefined,
  sourceFetchedAt: string | undefined,
): { readonly requestStartedAt: Date; readonly fetchedAt: Date } | null {
  if (!sourceDetectedAt && !sourceFetchedAt) return null;
  if (!sourceDetectedAt || !sourceFetchedAt) {
    throw new Error('Archived price-change source capture timestamps are incomplete');
  }
  const requestStartedAt = new Date(sourceDetectedAt);
  const fetchedAt = new Date(sourceFetchedAt);
  if (!Number.isFinite(requestStartedAt.getTime()) || !Number.isFinite(fetchedAt.getTime())) {
    throw new Error('Archived price-change source capture timestamps are invalid');
  }
  return { requestStartedAt, fetchedAt };
}

async function priceChangeCoreRepairOptions(job: Job<DataSyncJobData>) {
  const obligation = job.data.obligationId
    ? await getSchedulerObligation({ obligationId: job.data.obligationId }).catch(() => null)
    : null;
  const evidence = obligation?.evidence;
  const sourceHash =
    job.data.sourceHash ??
    (typeof evidence?.sourceHash === 'string' ? evidence.sourceHash : undefined);
  const sourceArtifactId =
    job.data.sourceArtifactId ??
    (typeof evidence?.sourceArtifactId === 'string' ? evidence.sourceArtifactId : undefined);
  const priceChangeBoardRevision =
    job.data.priceChangeBoardRevision ??
    (typeof evidence?.priceChangeBoardRevision === 'string'
      ? evidence.priceChangeBoardRevision
      : undefined);
  const sourceDetectedAt =
    job.data.sourceDetectedAt ??
    (typeof evidence?.sourceDetectedAt === 'string' ? evidence.sourceDetectedAt : undefined);
  const sourceFetchedAt =
    job.data.sourceFetchedAt ??
    (typeof evidence?.sourceFetchedAt === 'string' ? evidence.sourceFetchedAt : undefined);
  return {
    jobId: priceChangeCoreRepairJobId(job),
    removeOnSettle: false,
    ...(sourceHash ? { sourceHash } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    ...(priceChangeBoardRevision ? { priceChangeBoardRevision } : {}),
    ...(sourceDetectedAt ? { sourceDetectedAt } : {}),
    ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
  };
}

async function hotCoreSourceDependencies(job: Job<DataSyncJobData>) {
  if (job.name !== 'core-snapshot' || !job.data.sourceArtifactId || !job.data.sourceHash) {
    return undefined;
  }
  try {
    const source = await loadPriceChangeHotSource({
      artifactId: job.data.sourceArtifactId,
      sourceHash: job.data.sourceHash,
    });
    const capturedAt = archivedCaptureTimestamps(
      job.data.sourceDetectedAt,
      job.data.sourceFetchedAt,
    );
    logInfo('Using archived provisional source for legacy Core repair', {
      season: job.data.seasonCode,
      artifactId: job.data.sourceArtifactId,
      sourceHash: job.data.sourceHash,
      priceChangeBoardRevision: job.data.priceChangeBoardRevision,
    });
    return {
      bootstrap: source.payload,
      ...(capturedAt ? { sourceCheckedAt: capturedAt.requestStartedAt } : {}),
    };
  } catch (error) {
    logWarn('Archived provisional source unavailable; legacy Core repair will retry source-bound', {
      season: job.data.seasonCode,
      artifactId: job.data.sourceArtifactId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Archived price-change source unavailable for legacy Core repair: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function hotPriceSourceDependencies(job: Job<DataSyncJobData>) {
  if (job.name !== 'price-change-predictions') {
    return undefined;
  }
  const obligation =
    (!job.data.sourceArtifactId || !job.data.sourceHash) && job.data.obligationId
      ? await getSchedulerObligation({ obligationId: job.data.obligationId }).catch(() => null)
      : null;
  const sourceArtifactId =
    job.data.sourceArtifactId ??
    (typeof obligation?.evidence.sourceArtifactId === 'string'
      ? obligation.evidence.sourceArtifactId
      : undefined);
  const sourceHash =
    job.data.sourceHash ??
    (typeof obligation?.evidence.sourceHash === 'string'
      ? obligation.evidence.sourceHash
      : undefined);
  const boardRevision =
    job.data.priceChangeBoardRevision ??
    (typeof obligation?.evidence.priceChangeBoardRevision === 'string'
      ? obligation.evidence.priceChangeBoardRevision
      : undefined);
  if (!sourceHash) return undefined;
  try {
    const hotSnapshot = boardRevision
      ? await readPriceChangeHotSnapshotAtRevision(
          job.data.seasonCode,
          boardRevision,
          sourceHash,
        ).catch(() => null)
      : await readPriceChangeHotSnapshot(job.data.seasonCode).catch(() => null);
    if (!hotSnapshot || hotSnapshot.sourceHash !== sourceHash) {
      throw new Error('The provisional price-change source identity is unavailable');
    }
    const capturedAt =
      boardRevision && hotSnapshot.revision === boardRevision
        ? {
            requestStartedAt: new Date(hotSnapshot.detectedAt),
            fetchedAt: new Date(hotSnapshot.fetchedAt),
          }
        : archivedCaptureTimestamps(
            job.data.sourceDetectedAt ??
              (typeof obligation?.evidence.sourceDetectedAt === 'string'
                ? obligation.evidence.sourceDetectedAt
                : undefined),
            job.data.sourceFetchedAt ??
              (typeof obligation?.evidence.sourceFetchedAt === 'string'
                ? obligation.evidence.sourceFetchedAt
                : undefined),
          );
    if (!sourceArtifactId) {
      // The watcher publishes the hot board before archive I/O. If the raw
      // archive is unavailable, re-fetch with a source-bound cache key and
      // accept it only when the official trigger fingerprint is identical.
      // This prevents a five-minute edge-cache replay from overwriting the
      // detected board while still allowing durable reconciliation to recover.
      const expectedTriggerFingerprint = hotSnapshot.triggerFingerprint;
      logInfo('Re-fetching provisional source for durable reconciliation', {
        season: job.data.seasonCode,
        sourceHash,
        priceChangeBoardRevision: boardRevision,
      });
      return {
        getBootstrap: async (_requestStartedAtMs: number) => {
          const fetched = await fplClient.getBootstrapArtifact({
            edgeCacheKey: `price-hot-reconcile-${boardRevision ?? hotSnapshot.revision}-${sourceHash}`,
            priority: 'live',
            deadlineMs: 5_000,
          });
          const actualTriggerFingerprint = priceChangeTriggerFingerprint(fetched.payload);
          if (actualTriggerFingerprint !== expectedTriggerFingerprint) {
            throw new Error(
              'Price-change reconciliation source fingerprint differs from the detected hot source',
            );
          }
          return fetched.payload;
        },
        ...(capturedAt
          ? {
              captureTimestamps: {
                requestStartedAt: capturedAt.requestStartedAt,
                fetchedAt: capturedAt.fetchedAt,
              },
            }
          : {}),
      };
    }
    const source = await loadPriceChangeHotSource({
      artifactId: sourceArtifactId,
      sourceHash,
    });
    logInfo('Using archived provisional source for durable price reconciliation', {
      season: job.data.seasonCode,
      artifactId: sourceArtifactId,
      sourceHash,
      priceChangeBoardRevision: boardRevision,
    });
    return {
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
      'Archived provisional source unavailable; durable reconciliation will retry source-bound',
      {
        season: job.data.seasonCode,
        artifactId: sourceArtifactId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw new Error(
      `Archived price-change source unavailable for durable reconciliation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function markHotPriceReconciled(
  job: Job<DataSyncJobData>,
  publicationId: string | undefined,
  revision: number | undefined,
  preparedBoardRevision?: string,
): Promise<void> {
  if (!publicationId || revision === undefined) return;
  const obligation =
    !job.data.priceChangeBoardRevision && job.data.obligationId
      ? await getSchedulerObligation({ obligationId: job.data.obligationId }).catch(() => null)
      : null;
  const boardRevision =
    job.data.priceChangeBoardRevision ??
    (typeof obligation?.evidence.priceChangeBoardRevision === 'string'
      ? obligation.evidence.priceChangeBoardRevision
      : undefined);
  const sourceHash =
    job.data.sourceHash ??
    (typeof obligation?.evidence.sourceHash === 'string'
      ? obligation.evidence.sourceHash
      : undefined);
  if (!boardRevision) return;
  const snapshot = await readPriceChangeHotSnapshotAtRevision(
    job.data.seasonCode,
    boardRevision,
    sourceHash,
  ).catch(() => null);
  if (!snapshot || snapshot.revision !== boardRevision) return;
  if (preparedBoardRevision !== boardRevision) return;
  const updated = await markPriceChangeHotReconciliation(snapshot, {
    state: 'reconciled',
    durablePublicationId: publicationId,
    durableRevision: revision,
  });
  if (!updated) throw new Error('Price-change hot reconciliation CAS failed');
}

async function markHotPriceReconciliationFailed(
  job: Job<DataSyncJobData>,
  error: unknown,
): Promise<void> {
  if (job.name !== 'price-change-predictions') return;
  const obligation =
    !job.data.priceChangeBoardRevision && job.data.obligationId
      ? await getSchedulerObligation({ obligationId: job.data.obligationId }).catch(() => null)
      : null;
  const boardRevision =
    job.data.priceChangeBoardRevision ??
    (typeof obligation?.evidence.priceChangeBoardRevision === 'string'
      ? obligation.evidence.priceChangeBoardRevision
      : undefined);
  const sourceHash =
    job.data.sourceHash ??
    (typeof obligation?.evidence.sourceHash === 'string'
      ? obligation.evidence.sourceHash
      : undefined);
  if (!boardRevision) return;
  const snapshot = await readPriceChangeHotSnapshotAtRevision(
    job.data.seasonCode,
    boardRevision,
    sourceHash,
  ).catch(() => null);
  if (!snapshot || snapshot.revision !== boardRevision) return;
  const updated = await markPriceChangeHotReconciliation(snapshot, {
    state: 'failed',
    error,
  });
  if (!updated) throw new Error('Price-change hot reconciliation failure CAS failed');
}

async function alertPriceChangePublicationOverdue(
  job: Job<DataSyncJobData>,
  error: unknown,
): Promise<void> {
  if (job.name !== 'price-change-predictions' || !job.data.obligationId) return;
  const status = await schedulerObligationStatus({
    jobName: 'price-change-predictions',
    scopeKey: job.data.seasonCode,
  }).catch(() => null);
  if (!status || status.consecutiveUnsuccessfulCycles < 2) return;
  const latestPeriod = status.latest?.periodKey ?? 'unknown-period';
  const message = error instanceof Error ? error.message : String(error);
  await notifyTwoBots(
    [
      'Price-change publication overdue',
      `Season: ${job.data.seasonCode}`,
      `Cycles without a successful publication: ${status.consecutiveUnsuccessfulCycles}`,
      `Latest period: ${latestPeriod}`,
      `Error: ${message}`,
    ].join('\n'),
    { idempotencyKey: `price-change-overdue:${job.data.seasonCode}:${latestPeriod}` },
  );
}

const processDataSyncJob = async (job: Job<DataSyncJobData>) => {
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
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: job.data?.source as string | undefined,
    attempt: job.attemptsMade + 1,
    queueWaitMs: resolveBullMqAttemptQueueWaitMs(job),
  };
  const attemptContext: DataSyncAttemptContext = {
    queue: job.queueName,
    jobName: job.name,
    runId: job.data?.runId ?? String(job.id ?? `${job.name}-${job.timestamp}`),
    source: job.data?.source,
    attempt: job.attemptsMade + 1,
    targetEventId: job.data?.eventId,
    queueWaitMs: context.queueWaitMs,
  };
  const recordResolvedTarget = (eventId: number) => {
    attemptContext.targetEventId = eventId;
  };

  logJobTriggered(context);

  return runDataSyncAttempt(attemptContext, async () => {
    const mutationInput = {
      queueName: job.queueName,
      jobName: job.name,
      jobId: String(job.id),
    };

    // The player-values snapshot is the parent write for the price-sync job.
    // Commit it under the database scope before exposing the dependent job to
    // another worker; otherwise the child can read the previous snapshot.
    if (job.name === 'player-values') {
      return runTrackedJob(context, async () => {
        const changeDate = job.data.changeDate ?? formatCronDateKey(new Date(job.data.triggeredAt));
        // Fetch and validate the immutable upstream payload before taking the
        // canonical mutation lock.  Snapshot/view rows and the DB publication
        // proof/outbox are committed together; Redis delivery, notification,
        // and child enqueue happen only after that transaction commits.
        const prepared = await preparePlayerValuesSync(season, changeDate, undefined, {
          onTargetEventResolved: recordResolvedTarget,
        });
        if (!prepared) return { count: 0, outcome: 'noop' as const };
        let marketPublication: Awaited<ReturnType<typeof ensureMarketPublication>> | undefined;
        const result = await withMutationScopes(mutationInput, async () => {
          const persisted = await persistPreparedPlayerValuesSync(prepared, undefined, {
            deferPriceSyncEnqueue: true,
            deferMarketPublication: true,
            deferNotification: true,
          });
          marketPublication = await ensureMarketPublication(season, {
            deferDelivery: true,
            sourceRunId: job.data.runId,
            freshnessWindowId: job.data.freshnessWindowId,
          });
          return persisted;
        });
        if (marketPublication?.publicationId) {
          const delivered = await dispatchDataPublicationOutbox({
            limit: 1,
            publicationId: marketPublication.publicationId,
          });
          if (delivered.delivered !== 1) {
            const active = await readActiveDataPublication({
              dataset: 'fpl:market',
              seasonCode: season.seasonCode,
            });
            if (
              active?.manifest.publicationId !== marketPublication.publicationId ||
              active.manifest.revision !== marketPublication.revision
            ) {
              throw new Error(
                `Market publication ${marketPublication.publicationId} is canonical but Redis delivery is pending`,
              );
            }
          }
        }
        if (result.notificationMessage) {
          await notifyTwoBots(result.notificationMessage, {
            // Notifications are downstream of the canonical publication. Use
            // its immutable identity so retries after a process crash remain
            // idempotent even when they cross a UTC minute boundary.
            idempotencyKey: `market:${season.seasonCode}:${changeDate}:${marketPublication?.publicationId ?? 'snapshot'}`,
          });
        }
        if (result.count > 0) {
          await enqueuePlayerPricesSyncJob(season, 'cascade', {
            changeDate,
            jobId: `player-prices-${changeDate}-immediate`,
            removeOnSettle: false,
          });
        }
        return result;
      });
    }

    if (job.name === 'price-change-predictions') {
      return runTrackedJob(context, async () => {
        // Once the latest-wins producer is enabled, a legacy data-sync job
        // must not publish outside the lane fence during cutover. Its
        // durable obligation is completed as skipped by the worker event
        // handler, while the critical queue owns the replacement target.
        if (priceSingleFlightEnabled() && !job.data.laneId) {
          logInfo('Skipping legacy price-change job after latest-wins cutover', {
            jobId: job.id,
            obligationId: job.data.obligationId,
          });
          return {
            count: 0,
            outcome: 'noop' as const,
            reason: 'latest-wins-cutover' as const,
          };
        }
        // Bootstrap acquisition and all validation happen before the mutation
        // scopes are acquired.  The short locked section only activates the
        // immutable DB publication and its outbox receipt.
        let prepared;
        try {
          const hotSource = await hotPriceSourceDependencies(job);
          prepared = await preparePriceChangePublication(
            season,
            hotSource,
            job.data.source === 'manual' ? 'manual' : 'queue',
            job.data.runId,
            job.data.freshnessWindowId,
            job.data.freshnessWindowIds,
          );
        } catch (error) {
          if (error instanceof PriceChangeCorePublicationRequiredError) {
            await enqueueCoreSnapshotJob(
              season,
              'reconcile',
              await priceChangeCoreRepairOptions(job),
            ).catch((repairError) => {
              logError('Failed to enqueue core repair for price-change validation', repairError, {
                season: season.seasonCode,
              });
            });
          }
          throw error;
        }
        if (prepared.outcome === 'noop') return { count: 0, outcome: 'noop' as const };

        let persisted;
        try {
          persisted = await withMutationScopes(mutationInput, () =>
            persistPriceChangePublication(prepared, { deferDelivery: true }),
          );
        } catch (error) {
          await syncOperationsRepository
            .failRun(prepared.sourceRunId, error)
            .catch(() => undefined);
          if (error instanceof PriceChangeCorePublicationRequiredError) {
            await enqueueCoreSnapshotJob(
              season,
              'reconcile',
              await priceChangeCoreRepairOptions(job),
            ).catch((repairError) => {
              logError('Failed to enqueue core repair for price-change persistence', repairError, {
                season: season.seasonCode,
              });
            });
          }
          throw error;
        }
        const delivered = await dispatchDataPublicationOutbox({
          limit: 1,
          publicationId: persisted.publicationId,
        });
        if (delivered.delivered !== 1) {
          const active = await readActiveDataPublication({
            dataset: 'fpl:price-changes',
            seasonCode: season.seasonCode,
          });
          if (
            active?.manifest.publicationId !== persisted.publicationId ||
            active?.manifest.revision !== persisted.revision
          ) {
            throw new Error(
              `Price-change publication ${persisted.publicationId} is canonical but Redis delivery is pending`,
            );
          }
        }
        await markHotPriceReconciled(
          job,
          persisted.publicationId,
          persisted.revision,
          prepared.board.revision,
        );
        return persisted;
      });
    }

    const execute = () =>
      runTrackedJob(context, async () => {
        switch (job.name) {
          case 'core-snapshot':
            return syncCoreSnapshot(season, {
              trigger: 'queue',
              sourceRunId: job.data.runId,
              freshnessWindowId: job.data.freshnessWindowId,
              ...(await hotCoreSourceDependencies(job)),
            });
          case 'player-prices':
            if (!job.data.changeDate) {
              throw new Error('player-prices job requires changeDate');
            }
            return syncPlayerPricesForDate(season, job.data.changeDate);
          case 'player-stats':
            return job.data.eventId !== undefined
              ? syncPlayerStatsForEvent(season, job.data.eventId)
              : syncCurrentPlayerStats(season, { onTargetEventResolved: recordResolvedTarget });
          default:
            throw new Error(`Unknown data-sync job: ${job.name}`);
        }
      });

    // Core aliases perform upstream reads before acquiring their own short
    // multi-table persistence/publication lock.
    if (job.name === 'core-snapshot') return execute();
    return withMutationScopes(mutationInput, execute);
  });
};

export function createDataSyncWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<DataSyncJobData>(dataSyncQueueName, processDataSyncJob, {
    connection,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(dataSyncQueueName, { connection });

  worker.on('completed', (job, result) => {
    logInfo('Data sync job completed', { jobId: job.id, name: job.name });
    if (job.id !== undefined) {
      const skippedPriceChange =
        job.name === 'price-change-predictions' &&
        result !== null &&
        typeof result === 'object' &&
        'outcome' in result &&
        result.outcome === 'noop';
      const status = skippedPriceChange ? 'skipped' : 'succeeded';
      const skipReason =
        skippedPriceChange && 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : undefined;
      const evidence = {
        queue: dataSyncQueueName,
        jobName: job.name,
        ...(skippedPriceChange ? { reason: skipReason ?? 'official_fields_not_open' } : {}),
      };
      const fence = inspectSchedulerObligationFence(job.data);
      const completion =
        fence.kind === 'complete'
          ? completeSchedulerObligation({
              obligationId: fence.obligationId,
              generation: fence.generation,
              status,
              evidence,
            })
          : fence.kind === 'none'
            ? completeSchedulerObligationByBullJobId({
                bullJobId: job.id,
                status,
                evidence,
              })
            : null;
      if (completion) void completion.catch(() => undefined);
    }
  });

  worker.on('failed', (job, error) => {
    logError('Data sync job failed', error, {
      jobId: job?.id,
      name: job?.name,
      attemptsMade: job?.attemptsMade,
    });
    if (job) {
      void alertOnFinalFailure(job, error);
      if (isTerminalJobFailure(job, error)) {
        // Persist the terminal failure before reading the streak. Otherwise
        // the alert observes the previous database state and under-counts the
        // current failed cycle.
        void (async () => {
          const fence = inspectSchedulerObligationFence(job.data);
          await markHotPriceReconciliationFailed(job, error).catch((reconciliationError) => {
            logError('Price-change hot reconciliation failure update failed', reconciliationError, {
              jobId: job.id,
              season: job.data.seasonCode,
            });
          });
          if (fence.kind === 'complete') {
            await failSchedulerObligation({
              obligationId: fence.obligationId,
              generation: fence.generation,
              error,
            });
          } else if (fence.kind === 'none' && job.id !== undefined) {
            await failSchedulerObligationByBullJobId({ bullJobId: job.id, error });
          }
          await alertPriceChangePublicationOverdue(job, error);
        })().catch(() => undefined);
      }
    }
  });

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: dataSyncQueue, queueEvents, queueName: dataSyncQueueName }],
  };
}
