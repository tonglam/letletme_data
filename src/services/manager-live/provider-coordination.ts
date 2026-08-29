// Manager Live provider coordination implementation.
// Manager Live provider implementation. Kept behind the compatibility facade.
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type postgres from 'postgres';
import { EntrySummarySchema, fplClient } from '../../clients/fpl';
import {
  databaseTransactionStorage,
  getDb,
  runDatabasePostCommitActions,
  runInDatabaseTransaction,
} from '../../db/singleton';
import { readDatabaseOrderingTimestamp } from '../../db/ordering-timestamp';
import { type ManagerScoreScope } from '../../repositories/live-window';
import { FPLClientError } from '../../utils/errors';
import { logWarn } from '../../utils/logger';
import {
  acquireDistributedLease,
  createDistributedLeaseFence,
  createKeyedSerialTaskGate,
  createKeyedSerialTaskScheduler,
  createKeyedTaskSerializer,
  createManagerSummaryFetchGate,
  readThroughManagerSummaryResult,
  requireManagerSummaryCoordinator,
  runYieldingKeyedTask,
  type ManagerSummaryFetchPriority,
} from '../../domain/manager-live-fallback';
import type { FplRequestPriority } from '../../utils/fpl-admission';
import { dispatchManagerLiveRefresh } from '../manager-live-refresh-dispatch';
import {
  CLASSIC_REFRESH_LOCK_SECONDS,
  CLASSIC_REFRESH_LOCK_WAIT_MS,
  ENTRY_SUMMARY_SHARED_RESULT_SECONDS,
  REFRESH_DISPATCH_DEADLINE_MS,
  RELEASE_CLASSIC_REFRESH_LOCK_SCRIPT,
  RENEW_CLASSIC_REFRESH_LOCK_SCRIPT,
  nowIso,
  readCachedRowsForPublication,
  readClassicPublicationState,
  reconcileClassicRowsAfterCachePublication,
  scopeKey,
  writeCheckpointRows,
  writeClassicRowsMonotonically,
  writeRows,
} from './publication-store';

export const dispatchManagerLiveRefreshBounded = async (
  input: Parameters<typeof dispatchManagerLiveRefresh>[0],
): Promise<'QUEUED' | 'PENDING'> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const dispatch = dispatchManagerLiveRefresh(input).catch((error) => {
    if (timedOut) {
      logWarn('Manager live refresh dispatch failed after response deadline', {
        eventId: input.eventId,
        tournamentId: input.tournamentId ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
    throw error;
  });
  try {
    return await Promise.race([
      dispatch.then(() => 'QUEUED' as const),
      new Promise<'PENDING'>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve('PENDING');
        }, REFRESH_DISPATCH_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const tournamentRosterLifecycleMarker = (
  tournament: {
    rosterLastSyncedAt?: string | null;
    setupProgressUpdatedAt?: string | null;
  } | null,
): string | null => {
  if (!tournament) return null;
  const markers = [tournament.rosterLastSyncedAt, tournament.setupProgressUpdatedAt].filter(
    (marker): marker is string => typeof marker === 'string' && marker.length > 0,
  );
  return markers.length > 0 ? markers.join('|') : null;
};

export const runManagerLiveBackgroundRefresh = createKeyedSerialTaskScheduler();

// This gate is shared by every live-desk refresh in the process. Per-request
// batching alone is insufficient because distinct tournaments can refresh at
// the same time and otherwise multiply FPL entry-summary concurrency.
export const runManagerSummaryFetch = createManagerSummaryFetchGate();

function fplRequestPriority(priority: ManagerSummaryFetchPriority): FplRequestPriority {
  return priority === 'foreground' ? 'live' : 'bulk';
}

// Every classic standings crawl and its OR enrichment share one prioritized
// lane for a season/event/league. Foreground misses jump ahead of queued
// background work; disjoint jobs remain queued and different leagues proceed
// independently.
export const runClassicStandingsRefreshLocal = createKeyedTaskSerializer();

export const classicRefreshLockKey = (key: string): string =>
  `OfficialManagerLiveRefreshLock:${createHash('sha256').update(key).digest('hex')}`;

export class ManagerLiveLeaseOwnershipError extends Error {
  constructor(key: string, cause: unknown) {
    super(`official manager refresh lease ownership lost for ${key}`, { cause });
    this.name = 'ManagerLiveLeaseOwnershipError';
  }
}

export const entrySummarySharedResultKey = (
  season: string,
  eventId: number,
  entryId: number,
): string => `OfficialManagerLiveEntrySummaryResult:${season}:${eventId}:${entryId}`;

export type ManagerSummaryObservation = Readonly<{
  summary: Awaited<ReturnType<typeof fplClient.getEntrySummary>>;
  observedAt: string;
  publicationOrder: string | null;
}>;

export const parseManagerSummaryObservation = (value: string): ManagerSummaryObservation | null => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as {
      summary?: unknown;
      observedAt?: unknown;
      publicationOrder?: unknown;
    };
    if (typeof candidate.observedAt !== 'string') return null;
    const observedAtDate = new Date(candidate.observedAt);
    if (
      !Number.isFinite(observedAtDate.getTime()) ||
      observedAtDate.toISOString() !== candidate.observedAt
    ) {
      return null;
    }
    const publicationOrder = candidate.publicationOrder ?? null;
    if (publicationOrder !== null && typeof publicationOrder !== 'string') return null;
    const validated = EntrySummarySchema.safeParse(candidate.summary);
    return validated.success
      ? { summary: validated.data, observedAt: candidate.observedAt, publicationOrder }
      : null;
  } catch {
    return null;
  }
};

export const runClassicStandingsRefresh = <T>(
  redis: Redis | null,
  key: string,
  task: (assertLeaseOwned: () => Promise<void>) => Promise<T>,
  priority: ManagerSummaryFetchPriority = 'foreground',
  options: { acquireFailureMode?: 'fail-open' | 'fail-closed' } = {},
): Promise<T> => {
  if (!redis) {
    return runClassicStandingsRefreshLocal(key, () => task(async () => undefined), priority);
  }

  const lockKey = classicRefreshLockKey(key);
  return runYieldingKeyedTask<T>(
    runClassicStandingsRefreshLocal,
    key,
    async () => {
      const lockToken = randomBytes(16).toString('hex');
      const acquisition = await acquireDistributedLease(
        async () =>
          (await redis.set(lockKey, lockToken, 'EX', CLASSIC_REFRESH_LOCK_SECONDS, 'NX')) === 'OK',
        options.acquireFailureMode ?? 'fail-open',
        (error) =>
          logWarn('Official manager distributed refresh lock unavailable', {
            key,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      );
      if (acquisition === 'uncoordinated') {
        // Classic standings have an upstream publication clock and a durable
        // PostgreSQL ordering guard, so they remain serviceable if Redis is
        // unavailable. Unversioned entry summaries opt into fail-closed below.
        return { complete: true, value: await task(async () => undefined) };
      }
      if (acquisition === 'contended') {
        // A present lease is either actively renewed or will expire. Never
        // bypass an owner merely because this waiter is old: Redis expiry is
        // the takeover signal for a crashed/wedged owner, while an active
        // renewal proves that concurrent publication would be unsafe.
        return { complete: false };
      }

      const leaseFence = createDistributedLeaseFence(
        async () =>
          (await redis.eval(
            RENEW_CLASSIC_REFRESH_LOCK_SCRIPT,
            1,
            lockKey,
            lockToken,
            CLASSIC_REFRESH_LOCK_SECONDS,
          )) === 1,
        (error) =>
          logWarn('Official manager distributed refresh lease lost', {
            key,
            error: error instanceof Error ? error.message : 'unknown',
          }),
      );
      const renewTimer = setInterval(
        leaseFence.renewInBackground,
        Math.max(1_000, Math.floor((CLASSIC_REFRESH_LOCK_SECONDS * 1000) / 3)),
      );
      renewTimer.unref?.();

      try {
        const value = await task(leaseFence.assertOwned);
        await leaseFence.assertOwned();
        return { complete: true, value };
      } catch (error) {
        // A task may fail after a renewal was lost but before it reaches its
        // final fence. Probe once more so request paths can distinguish lease
        // loss from an ordinary upstream/publication failure and preserve
        // last-good rows instead of throwing the request.
        try {
          await leaseFence.assertOwned();
        } catch (leaseError) {
          throw new ManagerLiveLeaseOwnershipError(key, leaseError);
        }
        throw error;
      } finally {
        clearInterval(renewTimer);
        await redis
          .eval(RELEASE_CLASSIC_REFRESH_LOCK_SCRIPT, 1, lockKey, lockToken)
          .catch(() => undefined);
      }
    },
    priority,
    () => new Promise((resolve) => setTimeout(resolve, CLASSIC_REFRESH_LOCK_WAIT_MS)),
  );
};

export const fetchDistributedManagerSummary = async (
  redis: Redis | null,
  season: string,
  eventId: number,
  entryId: number,
  priority: ManagerSummaryFetchPriority = 'foreground',
  publicationKey?: string,
  publicationOrderingRequired = false,
  requestDeadlineMs?: number,
): Promise<ManagerSummaryObservation> => {
  // Some deployments (and the lightweight unit harness) expose only the
  // manager-row hash operations. In that mode there is no shared observation
  // coordinator; keep the durable checkpoint path usable with one bounded
  // official fetch rather than failing before contacting FPL.
  if (
    !redis ||
    typeof (redis as unknown as { get?: unknown }).get !== 'function' ||
    typeof (redis as unknown as { set?: unknown }).set !== 'function'
  ) {
    let publicationOrder: string | null = null;
    const summary = await runManagerSummaryFetch(
      async () =>
        publicationKey
          ? fplClient.getEntrySummary(entryId, {
              ...(requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs }),
              priority: fplRequestPriority(priority),
              beforeAttempt: async (_attempt, { signal }) => {
                try {
                  publicationOrder = (
                    await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                  ).exact;
                } catch (error) {
                  if (publicationOrderingRequired) throw error;
                  logWarn('Official manager summary ordering reservation failed', {
                    entryId,
                    error: error instanceof Error ? error.message : 'unknown',
                  });
                }
              },
            })
          : fplClient.getEntrySummary(
              entryId,
              requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs },
            ),
      priority,
      entryId,
    );
    return { summary, observedAt: nowIso(), publicationOrder };
  }
  const coordinator = requireManagerSummaryCoordinator(redis);
  return runClassicStandingsRefresh(
    coordinator,
    `entry-summary:${season}:${eventId}:${entryId}`,
    (assertLeaseOwned) =>
      readThroughManagerSummaryResult(
        async () => {
          try {
            const value = await coordinator.get(
              entrySummarySharedResultKey(season, eventId, entryId),
            );
            if (!value) return null;
            return parseManagerSummaryObservation(value);
          } catch (error) {
            logWarn('Official manager shared entry summary read failed', {
              entryId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            // Without the shared handoff read, another replica's validated
            // observation cannot be distinguished from a new unversioned
            // response. Fail closed and keep last-good rows.
            throw error;
          }
        },
        async () => {
          let publicationOrder: string | null = null;
          const summary = await runManagerSummaryFetch(
            async () =>
              publicationKey
                ? fplClient.getEntrySummary(entryId, {
                    ...(requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs }),
                    priority: fplRequestPriority(priority),
                    beforeAttempt: async (_attempt, { signal }) => {
                      try {
                        publicationOrder = (
                          await reserveManagerLivePublicationStartedAt(publicationKey, signal)
                        ).exact;
                      } catch (error) {
                        if (publicationOrderingRequired) throw error;
                        logWarn('Official manager summary ordering reservation failed', {
                          entryId,
                          error: error instanceof Error ? error.message : 'unknown',
                        });
                      }
                    },
                  })
                : fplClient.getEntrySummary(
                    entryId,
                    requestDeadlineMs === undefined ? {} : { deadlineMs: requestDeadlineMs },
                  ),
            priority,
            entryId,
          );
          return { summary, observedAt: nowIso(), publicationOrder };
        },
        async (observation) => {
          try {
            await assertLeaseOwned();
            await coordinator.set(
              entrySummarySharedResultKey(season, eventId, entryId),
              JSON.stringify(observation),
              'EX',
              ENTRY_SUMMARY_SHARED_RESULT_SECONDS,
            );
          } catch (error) {
            logWarn('Official manager shared entry summary write failed', {
              entryId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            // Do not publish a response that other replicas cannot reuse.
            // Otherwise a subsequent unversioned fetch could still regress it.
            throw error;
          }
        },
      ),
    priority,
    { acquireFailureMode: 'fail-closed' },
  );
};

// Cross-replica publication uses a short PostgreSQL transaction advisory lock.
// External FPL calls happen between a brief ordering reservation and this
// reconciliation lock, so a slow upstream never occupies the database pool.
export const runManagerLivePublicationInProcess = createKeyedSerialTaskGate();

export const runManagerLivePublication = <T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> =>
  runManagerLivePublicationInProcess(
    key,
    async (): Promise<T> => {
      if (signal?.aborted) throw signal.reason;
      const db = await getDb();
      const parentContext = databaseTransactionStorage.getStore();
      const postCommitActions = parentContext?.postCommitActions ?? [];
      const actionStart = postCommitActions.length;
      let result: T;
      try {
        result = (await db.transaction(async (drizzleTransaction) => {
          const transaction = (
            drizzleTransaction as unknown as {
              session?: { client?: postgres.TransactionSql };
            }
          ).session?.client;
          if (!transaction) {
            throw new Error('Drizzle transaction did not expose its pinned postgres client');
          }
          if (signal?.aborted) throw signal.reason;
          const lockQuery = transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`manager-live:${key}`}, 0))`;
          const cancelLock = (): void => lockQuery.cancel();
          signal?.addEventListener('abort', cancelLock, { once: true });
          try {
            await lockQuery;
          } finally {
            signal?.removeEventListener('abort', cancelLock);
          }
          if (signal?.aborted) throw signal.reason;
          return runInDatabaseTransaction(transaction, task, drizzleTransaction, postCommitActions);
        })) as T;
      } catch (error) {
        postCommitActions.splice(actionStart);
        throw error;
      }
      if (!parentContext) await runDatabasePostCommitActions(postCommitActions);
      return result;
    },
    signal,
  );

export const reserveManagerLivePublicationStartedAt = (
  key: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof readDatabaseOrderingTimestamp>>> =>
  runManagerLivePublication(key, () => readDatabaseOrderingTimestamp(), signal);

export const managerLivePublicationKey = (
  season: string,
  eventId: number,
  scope: ManagerScoreScope,
): string => `${season}:${eventId}:${scopeKey(scope)}`;

export const scheduleBackgroundRefresh = (
  serialKey: string,
  workKey: string,
  task: () => Promise<void>,
): void => {
  void runManagerLiveBackgroundRefresh(serialKey, workKey, task).catch((error) => {
    logWarn('Official manager live background refresh failed', {
      key: serialKey,
      workKey,
      error: error instanceof FPLClientError ? (error.code ?? error.status) : 'unknown',
    });
  });
};

export type EntrySummaryRefreshDependencies = {
  clock: { now(): Date };
  fetchSummary: typeof fetchDistributedManagerSummary;
  runPublication: typeof runManagerLivePublication;
  readPublicationState: typeof readClassicPublicationState;
  readCachedRowsForPublication: typeof readCachedRowsForPublication;
  readOrderingTimestamp: typeof readDatabaseOrderingTimestamp;
  writeCheckpointRows: typeof writeCheckpointRows;
  writeRows: typeof writeRows;
  writeCache: typeof writeClassicRowsMonotonically;
  reconcileCache: typeof reconcileClassicRowsAfterCachePublication;
};

export const productionEntrySummaryRefreshDependencies: EntrySummaryRefreshDependencies = {
  clock: { now: () => new Date() },
  fetchSummary: fetchDistributedManagerSummary,
  runPublication: runManagerLivePublication,
  readPublicationState: readClassicPublicationState,
  readCachedRowsForPublication,
  readOrderingTimestamp: readDatabaseOrderingTimestamp,
  writeCheckpointRows,
  writeRows,
  writeCache: writeClassicRowsMonotonically,
  reconcileCache: reconcileClassicRowsAfterCachePublication,
};
