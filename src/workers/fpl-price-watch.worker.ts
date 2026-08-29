import { randomUUID } from 'node:crypto';
import { QueueEvents, Worker, type Job } from 'bullmq';

import { fplClient } from '../clients/fpl';
import { requireCurrentSeasonForJob } from '../services/season-scoped-job.service';
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
  PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX,
  publishPriceChangeHotSnapshot,
  readPriceChangeHotSnapshot,
  sha256Bytes,
} from '../services/price-change-hot.service';
import {
  priceChangeBoardValueFingerprint,
  priceChangePrimaryDeadline,
  priceChangeTriggerFingerprint,
  priceChangeValueFingerprint,
  priceChangeObservedEventFromBaseline,
  normalizePriceChangeBoard,
  shouldPublishPriceChangeHotSnapshot,
  type PriceChangeBoard,
} from '../services/price-change-predictions.service';
import { triggerPriceChangeLane } from '../scheduler/scheduler.service';
import {
  completeSchedulerObligation,
  failSchedulerObligation,
} from '../services/scheduler-obligation-lifecycle.service';
import { startCurrentSchedulerJob } from '../utils/scheduler-obligation-fence';
import { parseStrictBooleanEnvValue } from '../utils/config';
import { FPLClientError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';
import { notifyTwoBots } from '../utils/notify';
import { type WorkerRuntime } from './worker-runtime';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import {
  FplAdmissionDeadlineExceededError,
  FplAdmissionStoreUnavailableError,
  openFplCriticalWindow,
} from '../utils/fpl-admission';
import {
  PRICE_CHANGE_WATCH_LEAD_MS,
  PRICE_CHANGE_WATCH_MAX_WINDOW_MS,
  PRICE_CHANGE_WATCH_RETRY_DELAYS_MS,
  resolvePriceChangeWatchSleepDelay,
} from '../domain/price-change-watch-policy';

function enabled(): boolean {
  return parseStrictBooleanEnvValue(
    process.env.PRICE_CHANGE_HOT_WATCH_ENABLED,
    process.env.NODE_ENV !== 'production',
    'PRICE_CHANGE_HOT_WATCH_ENABLED',
  );
}

function singleFlightEnabled(): boolean {
  return parseStrictBooleanEnvValue(
    process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED,
    process.env.NODE_ENV !== 'production',
    'PRICE_CHANGE_SINGLE_FLIGHT_ENABLED',
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function openPriceWatchCriticalWindowWithRetry(input: {
  readonly owner: string;
  readonly untilMs: number;
  readonly openWindow?: typeof openFplCriticalWindow;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onStoreFailure?: (error: FplAdmissionStoreUnavailableError) => void;
}): Promise<void> {
  const openWindow = input.openWindow ?? openFplCriticalWindow;
  const wait = input.sleep ?? sleep;
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  let failureCount = 0;
  let lastError: FplAdmissionStoreUnavailableError | null = null;
  while (now() <= input.untilMs) {
    try {
      await openWindow({ owner: input.owner, untilMs: input.untilMs });
      return;
    } catch (error) {
      if (!(error instanceof FplAdmissionStoreUnavailableError)) throw error;
      lastError = error;
      input.onStoreFailure?.(error);
      failureCount = Math.min(failureCount + 1, 3);
      const baseDelay = [250, 500, 1_000][failureCount - 1]!;
      const jitter = Math.floor(random() * Math.max(1, Math.floor(baseDelay * 0.25)));
      const remainingMs = input.untilMs - now();
      if (remainingMs <= 0) break;
      await wait(Math.min(baseDelay + jitter, remainingMs));
    }
  }
  throw (
    lastError ??
    new FplAdmissionStoreUnavailableError(
      new Error('FPL critical window could not be opened before the watch window ended'),
    )
  );
}

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

/** Reconstruct the pre-event prices when a worker restarts after hot publish. */
function watchBaselineFromBoard(
  board: PriceChangeBoard | null,
  deadlineAt: Date,
): PriceChangeBoard | null {
  if (!board) return null;
  const event = board.latestEvent;
  if (event && event.outcome === 'CHANGED' && Date.parse(event.deadline) === deadlineAt.getTime()) {
    const usableBoard = usablePriceChangeBaseline(board);
    if (!usableBoard) return null;
    const oldPrices = new Map(event.changes.map((change) => [change.playerId, change.oldPrice]));
    return {
      ...usableBoard,
      // The hot board revision includes the observed event and therefore is no
      // longer the identity of the fixed pre-cutover baseline. Keep the
      // original revision on the reconstructed board so every later provider
      // wave carries the same baselineRevision through cumulative diffs.
      revision: event.baselineRevision,
      latestEvent: null,
      players: usableBoard.players.map((player) => {
        const oldPrice = oldPrices.get(player.playerId);
        return oldPrice === undefined ? player : { ...player, currentPrice: oldPrice };
      }),
    };
  }
  const usableBoard = usablePriceChangeBaseline(board);
  if (!usableBoard) return null;
  // A durable publication captured at or after the watched deadline is not a
  // valid pre-cutover baseline. It may already contain the first price wave.
  const sourceCheckedAt = Date.parse(usableBoard.sourceCheckedAt ?? usableBoard.fetchedAt ?? '');
  if (Number.isFinite(sourceCheckedAt) && sourceCheckedAt >= deadlineAt.getTime()) return null;
  return usableBoard;
}

async function enqueueDurableReconciliation(
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
  snapshot: Awaited<ReturnType<typeof buildPriceChangeHotSnapshot>>,
): Promise<void> {
  const archiveUnavailable = snapshot.reconciliation.error?.startsWith(
    PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX,
  );
  // An artifact ID is only source-bound evidence when the archive was
  // verified. If archiving failed, retry without that ID so the durable lane
  // re-fetches authoritative data instead of retrying a permanently missing
  // object forever.
  const sourceArtifactId = archiveUnavailable ? undefined : (snapshot.artifactId ?? undefined);
  try {
    await triggerPriceChangeLane({
      sourceHash: snapshot.sourceHash,
      sourceArtifactId,
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
    sourceArtifactId,
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
    error,
  });
  if (!updated) throw new Error('Price-change hot reconciliation failure CAS failed');
}

async function publishAndReconcilePriceChangeHotSnapshot(input: {
  readonly season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>;
  readonly snapshot: Awaited<ReturnType<typeof buildPriceChangeHotSnapshot>>;
  readonly bytes: Uint8Array;
  readonly artifactId: string;
  readonly probeStartedAt: number;
}): Promise<Readonly<{ published: boolean; provisionalPublishedAt: string | null }>> {
  const { season, snapshot, bytes, artifactId, probeStartedAt } = input;
  const published = await publishPriceChangeHotSnapshot(snapshot);
  if (!published.published) return { published: false, provisionalPublishedAt: null };
  // This timestamp is taken immediately after the Redis hot write, before
  // source archiving or durable reconciliation can add latency to the user
  // visible path.
  const provisionalPublishedAt = new Date().toISOString();
  logInfo('Price-change hot snapshot published', {
    season: season.seasonCode,
    deadlineAt: snapshot.deadline,
    revision: snapshot.revision,
    triggerFingerprint: snapshot.triggerFingerprint,
    observedPlayerCount: snapshot.observedPlayerCount,
    outcome: snapshot.board.latestEvent?.outcome ?? null,
    changedPlayerCount: snapshot.board.latestEvent?.changedPlayerCount ?? null,
    detectionMs: Date.now() - probeStartedAt,
  });
  // The hot Redis write is the user-visible fast path. Archive and durable
  // reconciliation happen only after that write has succeeded.
  let archived = false;
  let archiveError: string | null = null;
  try {
    await archivePriceChangeHotSource({ artifactId, bytes, sourceHash: snapshot.sourceHash });
    archived = true;
  } catch (error) {
    archiveError = error instanceof Error ? error.message : String(error);
    logWarn('Price-change hot source archive failed; provisional data remains visible', {
      season: season.seasonCode,
      revision: snapshot.revision,
      artifactId,
      error: archiveError,
    });
    const marked = await markPriceChangeHotReconciliation(snapshot, {
      state: 'pending',
      error: `${PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX} ${archiveError}`,
    });
    if (!marked) throw new Error('Price-change hot archive failure CAS failed');
  }
  try {
    await enqueueDurableReconciliation(
      season,
      archived
        ? snapshot
        : {
            ...snapshot,
            artifactId: null,
            reconciliation: archiveError
              ? {
                  ...snapshot.reconciliation,
                  error: `${PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX} ${archiveError}`,
                }
              : snapshot.reconciliation,
          },
    );
  } catch (error) {
    await markHotReconciliationFailed(snapshot, error);
    throw error;
  }
  return { published: true, provisionalPublishedAt };
}

async function processPriceWatchJobCore(job: Job<FplPriceWatchJobData>) {
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
  const stopAt = deadlineAt.getTime() + PRICE_CHANGE_WATCH_MAX_WINDOW_MS;
  if (Date.now() >= stopAt) {
    const evidence = {
      reason: 'price-watch-window-expired-before-start',
      deadlineAt: deadlineAt.toISOString(),
      stopAt: new Date(stopAt).toISOString(),
      pollCount: 0,
      successfulProbes: 0,
      hotPublications: 0,
      noChangeObserved: false,
      postDeadlineSuccessfulProbe: false,
    };
    logWarn('Price-watch job started after its observation window expired', {
      season: season.seasonCode,
      ...evidence,
    });
    if (job.data.obligationId && job.data.obligationGeneration !== undefined) {
      const completed = await completeSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        status: 'skipped',
        evidence,
      });
      if (!completed) throw new Error('Price-watch expired completion CAS failed');
    }
    return { outcome: 'window-expired' as const, hotPublications: 0, pollCount: 0 };
  }
  const criticalWindowOwner = String(job.data.obligationId ?? job.id ?? randomUUID());
  let admissionStoreAlerted = false;
  const alertAdmissionStoreFailure = (error: unknown): void => {
    if (admissionStoreAlerted) return;
    admissionStoreAlerted = true;
    void notifyTwoBots(
      [
        'FPL admission store unavailable',
        `Season: ${season.seasonCode}`,
        `Deadline: ${deadlineAt.toISOString()}`,
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
      { idempotencyKey: `fpl-admission-store:${season.seasonCode}:${deadlineAt.toISOString()}` },
    ).catch(() => undefined);
  };
  await openPriceWatchCriticalWindowWithRetry({
    owner: criticalWindowOwner,
    untilMs: stopAt,
    onStoreFailure: alertAdmissionStoreFailure,
  });
  const windowStart = deadlineAt.getTime() - PRICE_CHANGE_WATCH_LEAD_MS;
  if (Date.now() < windowStart) await sleep(windowStart - Date.now());

  const [durableBoard, priorHot] = await Promise.all([
    getPriceChangePredictions().catch(() => null),
    readPriceChangeHotSnapshot(season.seasonCode).catch(() => null),
  ]);
  // A hot snapshot can be visible even when the asynchronous durable handoff
  // failed after the Redis write. Retry that exact source before using it as
  // the next value baseline; otherwise the unchanged official prices would be
  // treated as a no-op forever and the durable lane would never be re-enqueued.
  if (priorHot?.reconciliation.state === 'failed') {
    try {
      await enqueueDurableReconciliation(season, priorHot);
      logInfo('Retried failed price-change hot reconciliation handoff', {
        season: season.seasonCode,
        revision: priorHot.revision,
        sourceHash: priorHot.sourceHash,
      });
    } catch (error) {
      // Keep watching and leave the failure evidence intact. The next
      // scheduler pass will retry again, while the active hot board remains
      // the correct value baseline for this deadline.
      logWarn('Price-change hot reconciliation handoff retry failed', {
        season: season.seasonCode,
        revision: priorHot.revision,
        sourceHash: priorHot.sourceHash,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  let baselineBoard = watchBaselineFromBoard(priorHot?.board ?? durableBoard, deadlineAt);
  const baselineEvent = priorHot?.board.latestEvent ?? durableBoard?.latestEvent;
  const existingEventForDeadline = Boolean(
    baselineEvent && Date.parse(baselineEvent.deadline) === deadlineAt.getTime(),
  );
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
  let lastPostDeadlineArtifact: Awaited<ReturnType<typeof fplClient.getBootstrapArtifact>> | null =
    null;
  let lastPostDeadlineProbeStartedAt: number | null = null;
  let retryableFailureStreak = 0;
  let admissionStoreFailureStreak = 0;
  let admissionDeadlineFailures = 0;
  let admissionStoreFailures = 0;
  let providerFailures = 0;
  let firstChangedResponseAt: string | null = null;
  let firstChangedAdmissionWaitMs: number | null = null;
  let firstChangedProviderDurationMs: number | null = null;
  let firstProvisionalPublishedAt: string | null = null;

  while (Date.now() <= stopAt) {
    pollCount += 1;
    const probeStartedAt = Date.now();
    let probeAdmissionWaitMs: number | null = null;
    let probeProviderDurationMs: number | null = null;
    let probeResponseCompletedAt: Date | null = null;
    try {
      const artifact = await fplClient.getBootstrapArtifact({
        edgeCacheKey: `price-watch-${deadlineAt.getTime()}-${pollCount}`,
        priority: 'deadline-critical',
        deadlineMs: 5_000,
        admissionTimeoutMs: 750,
        attemptTimeoutMs: 5_000,
        overallDeadlineMs: 5_000,
        maxRetries: 0,
        onAttempt: ({ admissionWaitMs, providerDurationMs, completedAt }) => {
          probeAdmissionWaitMs = admissionWaitMs;
          probeProviderDurationMs = providerDurationMs;
          probeResponseCompletedAt = completedAt;
        },
      });
      const fingerprint = priceChangeTriggerFingerprint(artifact.payload);
      const valueFingerprint = priceChangeValueFingerprint(artifact.payload);
      const observedDeadline = priceChangePrimaryDeadline(artifact.payload);
      const observedDeadlineMs = Date.parse(observedDeadline);
      successfulProbes += 1;
      // A request that began before the official cutover can complete after it
      // and still contain the pre-change response. Only a probe initiated at
      // or after the deadline is evidence about the post-deadline state.
      const isPostDeadline = probeStartedAt >= deadlineAt.getTime();
      retryableFailureStreak = 0;
      admissionStoreFailureStreak = 0;
      const validPostDeadlineResponse =
        isPostDeadline &&
        Number.isFinite(observedDeadlineMs) &&
        observedDeadlineMs >= deadlineAt.getTime();
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
          try {
            baselineBoard = normalizePriceChangeBoard(artifact.payload, artifact.retrievedAt);
            initialized = true;
            previousValueFingerprint = priceChangeBoardValueFingerprint(baselineBoard);
            previousDeadline = observedDeadline;
            logInfo('Price-watch baseline established without an event', {
              season: season.seasonCode,
              deadlineAt: deadlineAt.toISOString(),
              fingerprint,
              pollCount,
            });
          } catch (error) {
            // Before the official fields open, a bootstrap may be structurally
            // valid but still lack the prediction payload required to form a
            // trustworthy baseline. Keep the watcher inconclusive until a
            // complete pre-deadline response arrives.
            logWarn('Price-watch pre-deadline baseline is not complete', {
              season: season.seasonCode,
              deadlineAt: deadlineAt.toISOString(),
              fingerprint,
              pollCount,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else if (
        validPostDeadlineResponse &&
        shouldPublishPriceChangeHotSnapshot(previousValueFingerprint, valueFingerprint)
      ) {
        if (!baselineBoard) throw new Error('Price-change watcher baseline disappeared');
        const latestEvent = priceChangeObservedEventFromBaseline({
          baseline: baselineBoard,
          bootstrap: artifact.payload,
          deadline: deadlineAt.toISOString(),
          fetchedAt: artifact.retrievedAt,
          outcome: 'CHANGED',
        });
        firstChangedResponseAt ??= (probeResponseCompletedAt ?? artifact.retrievedAt).toISOString();
        firstChangedAdmissionWaitMs ??= probeAdmissionWaitMs;
        firstChangedProviderDurationMs ??= probeProviderDurationMs;
        const sourceHash = sha256Bytes(artifact.bytes);
        const artifactId = createPriceChangeHotArtifactId();
        const observedCore = coreSnapshot as CoreSnapshotCacheContents | null;
        const snapshot = buildPriceChangeHotSnapshot({
          season,
          bootstrap: artifact.payload,
          sourceHash,
          artifactId,
          latestEvent,
          // Use the request start as the ordering lower bound. The response
          // may be replayed after a long queue/archive delay; stamping the
          // post-response clock could make older bytes appear newer than a
          // request that started later and already published.
          detectedAt: new Date(probeStartedAt),
          fetchedAt: artifact.retrievedAt,
          corePlayerCount: observedCore?.players.length ?? null,
          corePlayerDelta: observedCore
            ? artifact.payload.elements.length - observedCore.players.length
            : null,
        });
        const publication = await publishAndReconcilePriceChangeHotSnapshot({
          season,
          snapshot,
          bytes: artifact.bytes,
          artifactId,
          probeStartedAt,
        });
        if (publication.published) {
          hotPublications += 1;
          firstProvisionalPublishedAt ??= publication.provisionalPublishedAt;
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
        if (validPostDeadlineResponse && initialized) noChangeObserved = true;
      } else if (validPostDeadlineResponse) {
        noChangeObserved = true;
      }
      if (validPostDeadlineResponse && initialized) {
        postDeadlineSuccessfulProbe = true;
        lastPostDeadlineArtifact = artifact;
        lastPostDeadlineProbeStartedAt = probeStartedAt;
      }
    } catch (error) {
      // Only upstream transport/admission failures are retryable inside the
      // bounded watcher. A malformed validated payload or a Redis hot-write
      // failure must fail the obligation explicitly; treating either as a
      // quiet no-change day would hide an actual publication outage.
      if (!(error instanceof FPLClientError)) throw error;
      if (error instanceof FplAdmissionDeadlineExceededError) {
        admissionDeadlineFailures += 1;
        retryableFailureStreak = 0;
        admissionStoreFailureStreak = 0;
        logWarn('Price-watch probe admission deadline exceeded; keeping cadence', {
          season: season.seasonCode,
          deadlineAt: deadlineAt.toISOString(),
          pollCount,
          errorCode: error.code,
        });
      } else if (error instanceof FplAdmissionStoreUnavailableError) {
        admissionStoreFailures += 1;
        admissionStoreFailureStreak = Math.min(admissionStoreFailureStreak + 1, 3);
        retryableFailureStreak = 0;
        alertAdmissionStoreFailure(error);
        logWarn('Price-watch admission store unavailable; using short jittered retry', {
          season: season.seasonCode,
          deadlineAt: deadlineAt.toISOString(),
          pollCount,
          errorCode: error.code,
        });
      } else {
        admissionStoreFailureStreak = 0;
        const status = error.status;
        const retryable =
          error.code === 'UNKNOWN_ERROR' ||
          status === 429 ||
          (status !== undefined && status >= 500 && status <= 599);
        retryableFailureStreak = retryable ? Math.min(retryableFailureStreak + 1, 3) : 0;
        if (retryable) providerFailures += 1;
        logWarn('Price-watch probe failed; continuing bounded watch', {
          season: season.seasonCode,
          deadlineAt: deadlineAt.toISOString(),
          pollCount,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!retryable) throw error;
      }
    }
    const probeCompletedAt = Date.now();
    const retryDelay =
      admissionStoreFailureStreak > 0
        ? (() => {
            const base = [250, 500, 1_000][admissionStoreFailureStreak - 1]!;
            return base + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.25)));
          })()
        : retryableFailureStreak === 0
          ? 0
          : PRICE_CHANGE_WATCH_RETRY_DELAYS_MS[retryableFailureStreak - 1]!;
    const delay = resolvePriceChangeWatchSleepDelay({
      probeStartedAtMs: probeStartedAt,
      probeCompletedAtMs: probeCompletedAt,
      deadlineMs: deadlineAt.getTime(),
      stopAtMs: stopAt,
      retryDelayMs: retryDelay,
    });
    if (delay === null) break;
    await sleep(delay);
  }

  const firstChangedResponseToProvisionalMs =
    firstChangedResponseAt && firstProvisionalPublishedAt
      ? Math.max(0, Date.parse(firstProvisionalPublishedAt) - Date.parse(firstChangedResponseAt))
      : null;
  logInfo('Price-watch window completed', {
    season: season.seasonCode,
    deadlineAt: deadlineAt.toISOString(),
    pollCount,
    successfulProbes,
    hotPublications,
    noChangeObserved,
    postDeadlineSuccessfulProbe,
    firstChangedResponseAt,
    firstChangedAdmissionWaitMs,
    firstChangedProviderDurationMs,
    firstProvisionalPublishedAt,
    firstChangedResponseToProvisionalMs,
    admissionDeadlineFailures,
    admissionStoreFailures,
    providerFailures,
    watchDurationMs: Date.now() - startedAt,
  });
  if (
    hotPublications === 0 &&
    !existingEventForDeadline &&
    noChangeObserved &&
    baselineBoard &&
    lastPostDeadlineArtifact &&
    lastPostDeadlineProbeStartedAt !== null
  ) {
    const latestEvent = priceChangeObservedEventFromBaseline({
      baseline: baselineBoard,
      bootstrap: lastPostDeadlineArtifact.payload,
      deadline: deadlineAt.toISOString(),
      fetchedAt: lastPostDeadlineArtifact.retrievedAt,
      outcome: 'NO_CHANGE',
    });
    const sourceHash = sha256Bytes(lastPostDeadlineArtifact.bytes);
    const artifactId = createPriceChangeHotArtifactId();
    const observedCore = coreSnapshot as CoreSnapshotCacheContents | null;
    const snapshot = buildPriceChangeHotSnapshot({
      season,
      bootstrap: lastPostDeadlineArtifact.payload,
      sourceHash,
      artifactId,
      latestEvent,
      detectedAt: new Date(lastPostDeadlineProbeStartedAt),
      fetchedAt: lastPostDeadlineArtifact.retrievedAt,
      corePlayerCount: observedCore?.players.length ?? null,
      corePlayerDelta: observedCore
        ? lastPostDeadlineArtifact.payload.elements.length - observedCore.players.length
        : null,
    });
    const publication = await publishAndReconcilePriceChangeHotSnapshot({
      season,
      snapshot,
      bytes: lastPostDeadlineArtifact.bytes,
      artifactId,
      probeStartedAt: lastPostDeadlineProbeStartedAt,
    });
    if (publication.published) {
      hotPublications += 1;
      firstProvisionalPublishedAt ??= publication.provisionalPublishedAt;
    }
  }
  if (hotPublications === 0 && !postDeadlineSuccessfulProbe) {
    const evidence = {
      reason: 'price-watch-window-expired-without-post-deadline-evidence',
      deadlineAt: deadlineAt.toISOString(),
      stopAt: new Date(stopAt).toISOString(),
      pollCount,
      successfulProbes,
      hotPublications,
      noChangeObserved,
      postDeadlineSuccessfulProbe,
      firstChangedResponseAt,
      firstChangedAdmissionWaitMs,
      firstChangedProviderDurationMs,
      firstProvisionalPublishedAt,
      firstChangedResponseToProvisionalMs,
      admissionDeadlineFailures,
      admissionStoreFailures,
      providerFailures,
    };
    logWarn('Price-watch window expired without conclusive evidence', {
      season: season.seasonCode,
      ...evidence,
    });
    if (job.data.obligationId && job.data.obligationGeneration !== undefined) {
      const completed = await completeSchedulerObligation({
        obligationId: job.data.obligationId,
        generation: job.data.obligationGeneration,
        status: 'skipped',
        evidence,
      });
      if (!completed) throw new Error('Price-watch expiry completion CAS failed');
    }
    return { outcome: 'window-expired' as const, hotPublications, pollCount };
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
        firstChangedResponseAt,
        firstChangedAdmissionWaitMs,
        firstChangedProviderDurationMs,
        firstProvisionalPublishedAt,
        firstChangedResponseToProvisionalMs,
        admissionDeadlineFailures,
        admissionStoreFailures,
        providerFailures,
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

async function processPriceWatchJob(job: Job<FplPriceWatchJobData>) {
  const context = {
    jobType: 'queue' as const,
    jobName: job.name,
    queueName: fplPriceWatchQueueName,
    jobId: job.id,
    attempt: job.attemptsMade,
  };
  logJobTriggered(context);
  return runTrackedJob(context, () => processPriceWatchJobCore(job));
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
