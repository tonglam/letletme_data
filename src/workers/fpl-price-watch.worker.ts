import { randomUUID } from 'node:crypto';
import { QueueEvents, Worker, type Job } from 'bullmq';

import { fplClient } from '../clients/fpl';
import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import { enqueuePriceChangePredictionsJob } from '../jobs/data-sync-enqueue';
import {
  readCoreSnapshotCache,
  type CoreSnapshotCacheContents,
} from '../cache/core-snapshot-cache';
import {
  fplPriceWatchQueue,
  fplPriceWatchQueueName,
  type FplPriceWatchJobData,
} from '../queues/fpl-price-watch.queue';
import { getPriceChangePredictions } from '../services/price-change-predictions.service';
import {
  buildPriceChangeHotSnapshot,
  archivePriceChangeHotSource,
  createPriceChangeHotArtifactId,
  markPriceChangeHotReconciliation,
  publishPriceChangeHotSnapshot,
  readPriceChangeHotSnapshot,
  sha256Bytes,
} from '../services/price-change-hot.service';
import {
  priceChangeBoardValueFingerprint,
  priceChangePrimaryDeadline,
  priceChangeTriggerFingerprint,
  priceChangeValueFingerprint,
  shouldPublishPriceChangeHotSnapshot,
  type PriceChangeBoard,
} from '../services/price-change-predictions.service';
import { triggerPriceChangeLane } from '../scheduler/scheduler.service';
import {
  completeSchedulerObligation,
  failSchedulerObligation,
} from '../repositories/scheduler-obligations';
import { startCurrentSchedulerJob } from '../utils/scheduler-obligation-fence';
import { getConfig } from '../utils/config';
import { FPLClientError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';
import { type WorkerRuntime } from './worker-runtime';

export const PRICE_CHANGE_WATCH_LEAD_MS = 30_000;
export const PRICE_CHANGE_WATCH_FAST_POLL_MS = 2_000;
export const PRICE_CHANGE_WATCH_SLOW_POLL_MS = 5_000;
export const PRICE_CHANGE_WATCH_FAST_WINDOW_MS = 90_000;
export const PRICE_CHANGE_WATCH_MAX_WINDOW_MS = 5 * 60_000;

function enabled(): boolean {
  const raw = process.env.PRICE_CHANGE_HOT_WATCH_ENABLED;
  if (raw === undefined) return getConfig().NODE_ENV !== 'production';
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function singleFlightEnabled(): boolean {
  const raw = process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED;
  if (raw === undefined) return process.env.NODE_ENV !== 'production';
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function usablePriceChangeBaseline(board: PriceChangeBoard | null): PriceChangeBoard | null {
  if (
    !board ||
    !['READY', 'STALE'].includes(board.status) ||
    board.players.length === 0 ||
    board.expectedPlayerCount <= 0 ||
    board.observedPlayerCount !== board.players.length ||
    board.expectedPlayerCount !== board.observedPlayerCount
  ) {
    return null;
  }
  return board;
}

async function enqueueDurableReconciliation(
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
  snapshot: Awaited<ReturnType<typeof buildPriceChangeHotSnapshot>>,
): Promise<void> {
  try {
    await triggerPriceChangeLane({
      sourceHash: snapshot.sourceHash,
      sourceArtifactId: snapshot.artifactId ?? undefined,
      priceChangeBoardRevision: snapshot.revision,
      sourceDetectedAt: snapshot.detectedAt,
      sourceFetchedAt: snapshot.fetchedAt,
    });
    return;
  } catch (error) {
    // During flag-off rollout the latest-wins lane is intentionally absent.
    // Keep the hot board visible and use the existing durable producer as the
    // safe fallback. Once latest-wins is enabled, a legacy job without a lane
    // identity is deliberately skipped by data-sync, so enqueueing it would
    // create false completion and leave reconciliation pending.
    logWarn(
      singleFlightEnabled()
        ? 'Latest-wins price reconciliation unavailable; leaving hot reconciliation for scheduler retry'
        : 'Latest-wins price reconciliation unavailable; using legacy queue',
      {
        season: season.seasonCode,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    if (singleFlightEnabled()) throw error;
  }
  await enqueuePriceChangePredictionsJob(season, 'reconcile', {
    jobId: `price-change-hot-reconcile-${randomUUID()}`,
    removeOnSettle: false,
    sourceHash: snapshot.sourceHash,
    sourceArtifactId: snapshot.artifactId ?? undefined,
    priceChangeBoardRevision: snapshot.revision,
    sourceDetectedAt: snapshot.detectedAt,
    sourceFetchedAt: snapshot.fetchedAt,
  });
}

async function markHotReconciliationFailed(
  snapshot: Awaited<ReturnType<typeof buildPriceChangeHotSnapshot>>,
  error: unknown,
): Promise<void> {
  const current = await readPriceChangeHotSnapshot(snapshot.seasonCode).catch(() => null);
  if (!current || current.revision !== snapshot.revision) return;
  const updated = await markPriceChangeHotReconciliation(current, {
    state: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
  if (!updated) throw new Error('Price-change hot reconciliation failure CAS failed');
}

async function processPriceWatchJob(job: Job<FplPriceWatchJobData>) {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: fplPriceWatchQueueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { outcome: 'stale-scheduler-generation' as const };
  }
  if (!enabled()) {
    if (job.data.obligationId && job.data.obligationGeneration !== undefined) {
      const completed = await completeSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        status: 'skipped',
        evidence: { reason: 'price-hot-watch-disabled' },
      });
      if (!completed) throw new Error('Price-watch disabled completion CAS failed');
    }
    return { outcome: 'disabled' as const };
  }
  const season = await requireCurrentSeasonForJob(job.data);
  const deadlineAt = new Date(job.data.deadlineAt);
  if (!Number.isFinite(deadlineAt.getTime()))
    throw new Error('Price-watch job deadline is invalid');
  const startedAt = Date.now();
  const windowStart = deadlineAt.getTime() - PRICE_CHANGE_WATCH_LEAD_MS;
  if (Date.now() < windowStart) await sleep(windowStart - Date.now());

  const [durableBoard, priorHot] = await Promise.all([
    getPriceChangePredictions().catch(() => null),
    readPriceChangeHotSnapshot(season.seasonCode).catch(() => null),
  ]);
  // Core is observability metadata only on this path. Start the Redis read in
  // parallel, but never await it before publishing a hot board; if it is
  // ready by detection time, expose the player-count delta for reconciliation
  // diagnostics without turning Core admission into a hot-path dependency.
  let coreSnapshot: CoreSnapshotCacheContents | null = null;
  void readCoreSnapshotCache(season.seasonCode)
    .then((value) => {
      coreSnapshot = value;
    })
    .catch(() => undefined);
  // Keep the value baseline independent from the administrative deadline.
  // A worker can restart after the provider rolls the deadline forward; using
  // only a same-deadline baseline would then miss a real price move that was
  // already visible in the first post-restart probe. Conversely, when the
  // value fingerprint is unchanged, a deadline rollover remains a no-change
  // day and must not create a provisional board.
  const baselineBoard = priorHot?.board ?? usablePriceChangeBaseline(durableBoard);
  let previousValueFingerprint: string | null = baselineBoard
    ? priceChangeBoardValueFingerprint(baselineBoard)
    : null;
  let initialized = previousValueFingerprint !== null;
  let previousDeadline: string | null = baselineBoard?.deadline ?? null;
  let pollCount = 0;
  let successfulProbes = 0;
  let hotPublications = 0;
  let noChangeObserved = false;
  let postDeadlineSuccessfulProbe = false;
  let retryableFailureStreak = 0;
  const stopAt = deadlineAt.getTime() + PRICE_CHANGE_WATCH_MAX_WINDOW_MS;

  while (Date.now() <= stopAt) {
    pollCount += 1;
    const probeStartedAt = Date.now();
    try {
      const artifact = await fplClient.getBootstrapArtifact({
        edgeCacheKey: `price-watch-${deadlineAt.getTime()}-${pollCount}`,
        priority: 'live',
        deadlineMs: 5_000,
      });
      const fingerprint = priceChangeTriggerFingerprint(artifact.payload);
      const valueFingerprint = priceChangeValueFingerprint(artifact.payload);
      const observedDeadline = priceChangePrimaryDeadline(artifact.payload);
      successfulProbes += 1;
      // A request that began before the official cutover can complete after it
      // and still contain the pre-change response. Only a probe initiated at
      // or after the deadline is evidence about the post-deadline state.
      const isPostDeadline = probeStartedAt >= deadlineAt.getTime();
      retryableFailureStreak = 0;
      if (!initialized) {
        if (isPostDeadline) {
          // A first valid response after the official deadline may already
          // contain the changed prices. It is not evidence of "no change";
          // keep the watcher inconclusive rather than silently baselining the
          // post-change response and completing the obligation.
          logWarn('Price-watch cannot establish a post-deadline baseline', {
            season: season.seasonCode,
            deadlineAt: deadlineAt.toISOString(),
            fingerprint,
            pollCount,
          });
        } else {
          initialized = true;
          previousValueFingerprint = valueFingerprint;
          previousDeadline = observedDeadline;
          logInfo('Price-watch baseline established without an event', {
            season: season.seasonCode,
            deadlineAt: deadlineAt.toISOString(),
            fingerprint,
            pollCount,
          });
        }
      } else if (shouldPublishPriceChangeHotSnapshot(previousValueFingerprint, valueFingerprint)) {
        const sourceHash = sha256Bytes(artifact.bytes);
        const artifactId = createPriceChangeHotArtifactId();
        const observedCore = coreSnapshot as CoreSnapshotCacheContents | null;
        const snapshot = buildPriceChangeHotSnapshot({
          season,
          bootstrap: artifact.payload,
          sourceHash,
          artifactId,
          detectedAt: new Date(),
          fetchedAt: artifact.retrievedAt,
          corePlayerCount: observedCore?.players.length ?? null,
          corePlayerDelta: observedCore
            ? artifact.payload.elements.length - observedCore.players.length
            : null,
        });
        const published = await publishPriceChangeHotSnapshot(snapshot);
        if (published.published) {
          hotPublications += 1;
          logInfo('Price-change hot snapshot published', {
            season: season.seasonCode,
            deadlineAt: deadlineAt.toISOString(),
            revision: snapshot.revision,
            triggerFingerprint: snapshot.triggerFingerprint,
            observedPlayerCount: snapshot.observedPlayerCount,
            detectionMs: Date.now() - probeStartedAt,
          });
          // The hot Redis write is the user-visible fast path. Before handing
          // the artifact identity to reconciliation, archive and verify the
          // exact response so a worker cannot silently persist a different
          // bootstrap after an archive race or transient storage miss.
          let archived = false;
          try {
            await archivePriceChangeHotSource({
              artifactId,
              bytes: artifact.bytes,
              sourceHash,
            });
            archived = true;
          } catch (error) {
            logWarn('Price-change hot source archive failed; provisional data remains visible', {
              season: season.seasonCode,
              revision: snapshot.revision,
              artifactId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            await enqueueDurableReconciliation(
              season,
              archived ? snapshot : { ...snapshot, artifactId: null },
            );
          } catch (error) {
            await markHotReconciliationFailed(snapshot, error);
            throw error;
          }
        }
        previousValueFingerprint = valueFingerprint;
        previousDeadline = observedDeadline;
      } else if (observedDeadline !== previousDeadline) {
        // FPL advances the deadline list even when no player crossed a price
        // threshold. Do not turn that administrative rollover into a daily
        // hot publication; retain the new deadline as the next baseline.
        const rolledFrom = previousDeadline;
        previousDeadline = observedDeadline;
        logInfo('Price-watch deadline rolled without a price change', {
          season: season.seasonCode,
          previousDeadline: rolledFrom,
          observedDeadline,
          pollCount,
        });
      } else if (isPostDeadline) {
        postDeadlineSuccessfulProbe = true;
        noChangeObserved = true;
      }
      if (isPostDeadline && initialized) postDeadlineSuccessfulProbe = true;
    } catch (error) {
      // Only upstream transport/admission failures are retryable inside the
      // bounded watcher. A malformed validated payload or a Redis hot-write
      // failure must fail the obligation explicitly; treating either as a
      // quiet no-change day would hide an actual publication outage.
      if (!(error instanceof FPLClientError)) throw error;
      const status = error.status;
      const retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
      retryableFailureStreak = retryable ? Math.min(retryableFailureStreak + 1, 3) : 0;
      logWarn('Price-watch probe failed; continuing bounded watch', {
        season: season.seasonCode,
        deadlineAt: deadlineAt.toISOString(),
        pollCount,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!retryable) throw error;
    }
    const elapsedFromDeadline = Date.now() - deadlineAt.getTime();
    const interval =
      elapsedFromDeadline <= PRICE_CHANGE_WATCH_FAST_WINDOW_MS
        ? PRICE_CHANGE_WATCH_FAST_POLL_MS
        : PRICE_CHANGE_WATCH_SLOW_POLL_MS;
    const retryDelay =
      retryableFailureStreak === 0
        ? 0
        : [PRICE_CHANGE_WATCH_FAST_POLL_MS, PRICE_CHANGE_WATCH_SLOW_POLL_MS, 10_000][
            retryableFailureStreak - 1
          ];
    const remaining = stopAt - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(Math.max(interval, retryDelay), remaining));
  }

  logInfo('Price-watch window completed', {
    season: season.seasonCode,
    deadlineAt: deadlineAt.toISOString(),
    pollCount,
    successfulProbes,
    hotPublications,
    noChangeObserved,
    postDeadlineSuccessfulProbe,
    watchDurationMs: Date.now() - startedAt,
  });
  if (successfulProbes === 0) {
    throw new Error('Price-watch received no valid bootstrap response during its watch window');
  }
  if (hotPublications === 0 && !postDeadlineSuccessfulProbe) {
    throw new Error('Price-watch received no valid post-deadline bootstrap observation');
  }
  if (job.data.obligationId && job.data.obligationGeneration !== undefined) {
    const completed = await completeSchedulerObligation({
      obligationId: job.data.obligationId,
      generation: job.data.obligationGeneration,
      status: 'succeeded',
      evidence: {
        deadlineAt: deadlineAt.toISOString(),
        pollCount,
        successfulProbes,
        hotPublications,
        noChangeObserved,
        postDeadlineSuccessfulProbe,
      },
    });
    if (!completed) throw new Error('Price-watch completion CAS failed');
  }
  return {
    outcome: hotPublications > 0 ? ('published' as const) : ('no-change' as const),
    hotPublications,
    pollCount,
  };
}

export function createFplPriceWatchWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<FplPriceWatchJobData>(fplPriceWatchQueueName, processPriceWatchJob, {
    connection,
    concurrency: 1,
    lockDuration: 7 * 60_000,
    maxStalledCount: 1,
    stalledInterval: 30_000,
  });
  const queueEvents = new QueueEvents(fplPriceWatchQueueName, { connection });
  worker.on('completed', (job, result) => {
    logInfo('FPL price-watch job completed', {
      queue: fplPriceWatchQueueName,
      jobId: job.id,
      outcome: result?.outcome ?? 'unknown',
    });
  });
  worker.on('failed', (job, error) => {
    if (!job) return;
    logError('FPL price-watch job failed', error, {
      queue: fplPriceWatchQueueName,
      jobId: job.id,
      deadlineAt: job.data.deadlineAt,
    });
    if (job.data.obligationId && job.data.obligationGeneration !== undefined) {
      void failSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        error,
      })
        .then((updated) => {
          if (!updated) {
            logError(
              'Price-watch failure reconciliation CAS failed',
              new Error('Scheduler obligation was not updated'),
              { jobId: job.id, obligationId: job.data.obligationId },
            );
          }
        })
        .catch((failure) => logError('Price-watch failure reconciliation failed', failure));
    }
  });
  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: fplPriceWatchQueue, queueEvents, queueName: fplPriceWatchQueueName }],
  };
}
