const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;
// A Classic board enriches at most 20 managers synchronously. Larger rosters
// keep the same upstream request budget and finish through the background gate.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;

export type ManagerSummaryFetchPriority = 'foreground' | 'background';

export type ComparableManagerLiveRow = Readonly<{
  source: 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | 'FPL_FINAL_RESULT';
  checkedAt: string;
  upstreamUpdatedAt: string | null;
}>;

const managerLiveSourcePriority = (source: ComparableManagerLiveRow['source']): number =>
  source === 'FPL_FINAL_RESULT' ? 3 : source === 'FPL_CLASSIC_STANDINGS' ? 2 : 1;

export const shouldReplaceManagerLiveRow = (
  current: ComparableManagerLiveRow,
  incoming: ComparableManagerLiveRow,
): boolean => {
  const currentCheckedAt = Date.parse(current.checkedAt);
  const incomingCheckedAt = Date.parse(incoming.checkedAt);
  if (!Number.isFinite(currentCheckedAt)) return Number.isFinite(incomingCheckedAt);
  if (!Number.isFinite(incomingCheckedAt)) return false;

  const currentPriority = managerLiveSourcePriority(current.source);
  const incomingPriority = managerLiveSourcePriority(incoming.source);
  if (currentPriority !== incomingPriority) return incomingPriority > currentPriority;

  if (current.source === 'FPL_CLASSIC_STANDINGS') {
    const currentUpstream = Date.parse(current.upstreamUpdatedAt ?? '');
    const incomingUpstream = Date.parse(incoming.upstreamUpdatedAt ?? '');
    if (
      Number.isFinite(currentUpstream) &&
      Number.isFinite(incomingUpstream) &&
      currentUpstream !== incomingUpstream
    ) {
      return incomingUpstream > currentUpstream;
    }
  }

  return incomingCheckedAt >= currentCheckedAt;
};

export const selectForegroundClassicRankEntryIds = <T>(
  requestedEntryIds: readonly number[],
  rows: ReadonlyMap<number, T>,
  isFresh: (row: T) => boolean,
  needsOverallRank: (row: T) => boolean,
  maxFetches: number,
): readonly number[] =>
  requestedEntryIds
    .filter((entryId) => {
      const row = rows.get(entryId);
      return row !== undefined && isFresh(row) && needsOverallRank(row);
    })
    .slice(0, maxFetches);

export const shouldEnrichClassicOverallRank = <T>(
  entryId: number,
  row: T,
  refreshedEntryIds: ReadonlySet<number>,
  rankOnlyEntryIds: ReadonlySet<number>,
  isFresh: (row: T) => boolean,
  needsOverallRank: (row: T) => boolean,
): boolean =>
  refreshedEntryIds.has(entryId) ||
  (rankOnlyEntryIds.has(entryId) && isFresh(row) && needsOverallRank(row));

export type KeyedTaskSerializer = <T>(
  key: string,
  task: () => Promise<T>,
  priority?: ManagerSummaryFetchPriority,
) => Promise<T>;

export type YieldingKeyedTaskAttempt<T> =
  | Readonly<{ complete: false }>
  | Readonly<{ complete: true; value: T }>;

export type DistributedLeaseAcquireFailureMode = 'fail-open' | 'fail-closed';
export type DistributedLeaseAcquireResult = 'owned' | 'contended' | 'uncoordinated';

export const requireManagerSummaryCoordinator = <T>(coordinator: T | null): T => {
  if (coordinator === null) {
    throw new Error('manager summary distributed coordination unavailable');
  }
  return coordinator;
};

export const acquireDistributedLease = async (
  acquire: () => Promise<boolean>,
  failureMode: DistributedLeaseAcquireFailureMode,
  onError?: (error: unknown) => void,
): Promise<DistributedLeaseAcquireResult> => {
  try {
    return (await acquire()) ? 'owned' : 'contended';
  } catch (error) {
    onError?.(error);
    if (failureMode === 'fail-closed') throw error;
    return 'uncoordinated';
  }
};

export type DistributedLeaseFence = Readonly<{
  assertOwned: () => Promise<void>;
  renewInBackground: () => void;
}>;

export const createDistributedLeaseFence = (
  renew: () => Promise<boolean>,
  onLost?: (error: unknown) => void,
): DistributedLeaseFence => {
  let lostError: Error | null = null;
  let renewalInFlight: Promise<void> | null = null;

  const renewLease = (): Promise<void> => {
    if (lostError) return Promise.reject(lostError);
    if (renewalInFlight) return renewalInFlight;

    const active = (async () => {
      try {
        if (!(await renew())) throw new Error('distributed lease ownership lost');
      } catch (error) {
        lostError = error instanceof Error ? error : new Error('distributed lease renewal failed');
        onLost?.(error);
        throw lostError;
      }
    })();
    renewalInFlight = active;
    void active
      .finally(() => {
        if (renewalInFlight === active) renewalInFlight = null;
      })
      .catch(() => undefined);
    return active;
  };

  return {
    // Publication paths await this immediately before writing. The renewal
    // both proves token ownership and extends the lease long enough for the
    // following Redis write to remain fenced from a replacement owner.
    assertOwned: renewLease,
    renewInBackground: () => {
      void renewLease().catch(() => undefined);
    },
  };
};

export const runYieldingKeyedTask = async <T>(
  run: KeyedTaskSerializer,
  key: string,
  attempt: () => Promise<YieldingKeyedTaskAttempt<T>>,
  priority: ManagerSummaryFetchPriority,
  yieldBeforeRetry: () => Promise<void>,
): Promise<T> => {
  while (true) {
    const result = await run(key, attempt, priority);
    if (result.complete) return result.value;
    // Wait outside the keyed serializer. A background lease poll must not
    // remain the active local task and prevent a newly queued foreground miss
    // from competing for the distributed lease.
    await yieldBeforeRetry();
  }
};

export type ManagerStandingsPageResult<TError> = Readonly<{
  complete: boolean;
  nextPage: number;
  errorCode: TError | null;
  refreshedEntryIds: readonly number[];
}>;

export const runManagerStandingsPageSequence = async <TError>(
  startPage: number,
  maxPage: number,
  runPage: (page: number) => Promise<ManagerStandingsPageResult<TError>>,
): Promise<ManagerStandingsPageResult<TError>> => {
  if (
    !Number.isSafeInteger(startPage) ||
    startPage <= 0 ||
    !Number.isSafeInteger(maxPage) ||
    maxPage <= 0
  ) {
    throw new RangeError('standings page bounds must be positive integers');
  }

  let nextPage = startPage;
  let complete = startPage > maxPage;
  let errorCode: TError | null = null;
  const refreshedEntryIds = new Set<number>();

  while (!complete && nextPage <= maxPage) {
    const currentPage = nextPage;
    const result = await runPage(currentPage);
    for (const entryId of result.refreshedEntryIds) refreshedEntryIds.add(entryId);
    nextPage = result.nextPage;
    errorCode = result.errorCode;
    complete = result.complete || (errorCode === null && nextPage > maxPage);
    if (complete || errorCode !== null) break;
    if (!Number.isSafeInteger(nextPage) || nextPage <= currentPage) {
      throw new RangeError('standings page sequence must advance');
    }
  }

  return {
    complete,
    nextPage,
    errorCode,
    refreshedEntryIds: Array.from(refreshedEntryIds),
  };
};

export const classicManagerBackgroundStandingsStartPage = (
  standingsEntryIds: readonly number[],
  coldEntryIds: ReadonlySet<number>,
  foregroundNextPage: number,
): number => {
  if (!Number.isSafeInteger(foregroundNextPage) || foregroundNextPage <= 0) {
    throw new RangeError('foregroundNextPage must be a positive integer');
  }
  // Stale standings can change on page 1 and therefore require a fresh crawl.
  // A cold-only continuation has already paid for the bounded foreground
  // prefix, so resume at the exact upstream cursor instead of re-fetching it.
  return standingsEntryIds.some((entryId) => !coldEntryIds.has(entryId)) ? 1 : foregroundNextPage;
};

export const readThroughManagerSummaryResult = async <T>(
  readShared: () => Promise<T | null>,
  fetchOfficial: () => Promise<T>,
  writeShared: (value: T) => Promise<void>,
): Promise<T> => {
  const shared = await readShared();
  if (shared !== null) return shared;
  const official = await fetchOfficial();
  // The distributed owner publishes the validated response before releasing
  // its lease. Waiters then reuse exactly the same upstream observation rather
  // than issuing a second request whose snapshot has no version metadata.
  await writeShared(official);
  return official;
};

export const createKeyedTaskSerializer = (): KeyedTaskSerializer => {
  type QueuedTask = {
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  };
  type KeyState = {
    active: boolean;
    foreground: QueuedTask[];
    background: QueuedTask[];
  };
  const states = new Map<string, KeyState>();

  const startNext = (key: string, state: KeyState): void => {
    if (state.active) return;
    const next = state.foreground.shift() ?? state.background.shift();
    if (!next) {
      states.delete(key);
      return;
    }
    state.active = true;
    void Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        state.active = false;
        startNext(key, state);
      });
  };

  return <T>(
    key: string,
    task: () => Promise<T>,
    priority: ManagerSummaryFetchPriority = 'foreground',
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const state = states.get(key) ?? {
        active: false,
        foreground: [],
        background: [],
      };
      states.set(key, state);
      state[priority].push({
        task,
        resolve: (value) => resolve(value as T),
        reject,
      });
      startNext(key, state);
    });
};

export const readLatestRowsWithFallback = async <T extends { checkedAt: string }>(
  entryIds: readonly number[],
  capturedRows: ReadonlyMap<number, T>,
  readRows: () => Promise<ReadonlyMap<number, T>>,
  onReadError?: (error: unknown) => void,
): Promise<Map<number, T>> => {
  const rows = new Map<number, T>();
  for (const entryId of entryIds) {
    const captured = capturedRows.get(entryId);
    if (captured) rows.set(entryId, captured);
  }
  try {
    const cachedRows = await readRows();
    for (const [entryId, cached] of cachedRows) {
      const captured = rows.get(entryId);
      // The caller's live read is authoritative at the time it runs, so it
      // wins timestamp ties over a request-captured snapshot.
      const capturedCheckedAt = captured ? Date.parse(captured.checkedAt) : Number.NaN;
      const cachedCheckedAt = Date.parse(cached.checkedAt);
      if (
        !captured ||
        (!Number.isFinite(capturedCheckedAt) && Number.isFinite(cachedCheckedAt)) ||
        (Number.isFinite(cachedCheckedAt) && cachedCheckedAt >= capturedCheckedAt)
      ) {
        rows.set(entryId, cached);
      }
    }
  } catch (error) {
    onReadError?.(error);
  }
  return rows;
};

export const preserveClassicOverallRank = (
  incomingOverallRank: number | null,
  existingOverallRank: number | null | undefined,
): number | null => {
  if (
    typeof incomingOverallRank === 'number' &&
    Number.isSafeInteger(incomingOverallRank) &&
    incomingOverallRank > 0
  ) {
    return incomingOverallRank;
  }
  return typeof existingOverallRank === 'number' &&
    Number.isSafeInteger(existingOverallRank) &&
    existingOverallRank > 0
    ? existingOverallRank
    : incomingOverallRank;
};

export const planManagerLiveRefreshTargets = (
  requestedEntryIds: readonly number[],
  cachedEntryIds: ReadonlySet<number>,
  freshEntryIds: ReadonlySet<number>,
  options: { foregroundStale?: boolean } = {},
): Readonly<{
  foregroundEntryIds: readonly number[];
  backgroundEntryIds: readonly number[];
}> => ({
  // Missing rows still need a bounded request-path attempt so a cold cache can
  // return useful data. Live Classic competition boards also foreground stale
  // rows: their event score is the ranking metric, so serving an old last-good
  // standings row while a newer entry summary is visible creates a
  // user-visible source split.
  foregroundEntryIds: requestedEntryIds.filter(
    (entryId) =>
      !cachedEntryIds.has(entryId) ||
      (options.foregroundStale === true && !freshEntryIds.has(entryId)),
  ),
  // Background work includes both missing and stale rows, but excludes rows
  // refreshed inside the current freshness window.
  backgroundEntryIds: requestedEntryIds.filter((entryId) => !freshEntryIds.has(entryId)),
});

type ClassicHeadlineObservation = Readonly<{
  source: string;
  checkedAt: string;
  upstreamUpdatedAt?: string | null;
}>;

const managerLiveContentTimestamp = (row: ClassicHeadlineObservation): number => {
  const upstreamTimestamp = Date.parse(row.upstreamUpdatedAt ?? '');
  return Number.isFinite(upstreamTimestamp) ? upstreamTimestamp : Date.parse(row.checkedAt);
};

export const shouldPreferEntrySummaryForClassicHeadline = (
  classicRow: ClassicHeadlineObservation | undefined,
  entrySummaryRow: ClassicHeadlineObservation | undefined,
): boolean => {
  if (entrySummaryRow?.source !== 'FPL_ENTRY_SUMMARY') return false;
  const summaryContentAt = managerLiveContentTimestamp(entrySummaryRow);
  if (!Number.isFinite(summaryContentAt)) return false;
  if (!classicRow) return true;
  // A missing Classic standings row is represented by an Entry Summary
  // fallback. Allow a newer summary to converge that fallback as well; only a
  // real standings row contributes the league-rank preservation in the merge.
  if (classicRow.source !== 'FPL_CLASSIC_STANDINGS' && classicRow.source !== 'FPL_ENTRY_SUMMARY') {
    return false;
  }
  const classicContentAt = managerLiveContentTimestamp(classicRow);
  return !Number.isFinite(classicContentAt) || summaryContentAt >= classicContentAt;
};

export const pendingManagerRefreshEntryIds = <T>(
  requestedEntryIds: readonly number[],
  rows: ReadonlyMap<number, T>,
  isFresh: (row: T) => boolean,
): readonly number[] =>
  requestedEntryIds.filter((entryId) => {
    const row = rows.get(entryId);
    return !row || !isFresh(row);
  });
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('Manager live task aborted');

const awaitTaskOrAbort = <T>(task: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export const createKeyedSerialTaskGate = (): (<T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>) => {
  const tails = new Map<string, Promise<void>>();

  return async <T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    tails.set(key, turn);

    await previous;
    try {
      if (signal?.aborted) throw abortReason(signal);
      return await awaitTaskOrAbort(task(), signal);
    } finally {
      releaseTurn();
      if (tails.get(key) === turn) tails.delete(key);
    }
  };
};

export const createKeyedSerialTaskScheduler = (): ((
  serialKey: string,
  workKey: string,
  task: () => Promise<void>,
) => Promise<void>) => {
  const runSerialTask = createKeyedSerialTaskGate();
  const scheduledWork = new Map<string, Promise<void>>();

  return (serialKey: string, workKey: string, task: () => Promise<void>): Promise<void> => {
    const existing = scheduledWork.get(workKey);
    if (existing) return existing;

    const promise = runSerialTask(serialKey, task).finally(() => {
      if (scheduledWork.get(workKey) === promise) scheduledWork.delete(workKey);
    });
    scheduledWork.set(workKey, promise);
    return promise;
  };
};

export const isPositiveOverallRank = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const preserveLastKnownOverallRank = (
  incoming: number | null | undefined,
  previous: number | null | undefined,
): number | null => {
  if (isPositiveOverallRank(incoming)) return incoming;
  return isPositiveOverallRank(previous) ? previous : null;
};

export const selectClassicSummaryOverallRank = (
  incoming: number | null | undefined,
  existing: number | null | undefined,
  acceptIncoming: boolean,
): number | null => {
  if (acceptIncoming && isPositiveOverallRank(incoming)) return incoming;
  return isPositiveOverallRank(existing) ? existing : null;
};

export const reconcileMonotonicCachePublicationRows = <T extends Readonly<{ entryId: number }>>(
  publishedRows: readonly T[],
  cacheUpdatedEntryIds: readonly number[] | null,
  authoritativeRejectedRows: ReadonlyMap<number, T>,
): T[] => {
  // A null result means Redis was unavailable, so the just-committed
  // PostgreSQL rows remain the best response-local evidence. A concrete list
  // comes from the monotonic Lua publication and identifies exactly which
  // rows were accepted by Redis.
  if (cacheUpdatedEntryIds === null) return [...publishedRows];

  const cacheUpdated = new Set(cacheUpdatedEntryIds);
  return publishedRows.flatMap((row) => {
    if (cacheUpdated.has(row.entryId)) return [row];
    const authoritative = authoritativeRejectedRows.get(row.entryId);
    // Never expose the rejected stale publication. If its newer Redis/DB row
    // cannot be re-read, leave the caller's existing response row untouched.
    return authoritative ? [authoritative] : [];
  });
};

const normalizeOrderingTimestamp = (value: string | null | undefined): string | null => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.)(\d{1,6})Z$/.exec(value);
  if (!match) return null;
  return `${match[1]}${match[2].padEnd(6, '0')}Z`;
};

export const isNewerClassicOverallRankPublicationOrder = (
  publicationOrder: string,
  lastAcceptedPublicationOrder: string | null | undefined,
): boolean => {
  const incomingOrder = normalizeOrderingTimestamp(publicationOrder);
  if (!incomingOrder) return false;
  const acceptedOrder = normalizeOrderingTimestamp(lastAcceptedPublicationOrder);
  return acceptedOrder === null || incomingOrder > acceptedOrder;
};

export const shouldAcceptClassicOverallRankPublication = (
  incoming: number | null | undefined,
  publicationOrder: string,
  lastAcceptedPublicationOrder: string | null | undefined,
): boolean =>
  isPositiveOverallRank(incoming) &&
  isNewerClassicOverallRankPublicationOrder(publicationOrder, lastAcceptedPublicationOrder);

export const mergeUniqueTargetManagerRows = <T extends Readonly<{ entryId: number }>>(
  existing: ReadonlyMap<number, T>,
  pageRows: readonly T[],
  targetIds: ReadonlySet<number>,
): Map<number, T> => {
  const merged = new Map(existing);
  for (const row of pageRows) {
    if (targetIds.has(row.entryId)) merged.set(row.entryId, row);
  }
  return merged;
};

export const selectLatestCheckedRow = <
  T extends Readonly<{
    checkedAt: string;
    upstreamUpdatedAt?: string | null;
  }>,
>(
  current: T | undefined,
  candidate: T,
): T => {
  if (!current) return candidate;

  const currentUpstreamTime = Date.parse(current.upstreamUpdatedAt ?? '');
  const candidateUpstreamTime = Date.parse(candidate.upstreamUpdatedAt ?? '');
  if (
    Number.isFinite(currentUpstreamTime) &&
    Number.isFinite(candidateUpstreamTime) &&
    currentUpstreamTime !== candidateUpstreamTime
  ) {
    return candidateUpstreamTime > currentUpstreamTime ? candidate : current;
  }

  const currentTime = Date.parse(current.checkedAt);
  const candidateTime = Date.parse(candidate.checkedAt);
  return Number.isFinite(candidateTime) &&
    (!Number.isFinite(currentTime) || candidateTime > currentTime)
    ? candidate
    : current;
};

export const selectEarlierManagerLiveObservationAt = (left: string, right: string): string => {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return leftTime <= rightTime ? left : right;
};

export const shouldRefreshClassicOverallRank = (
  row:
    | Readonly<{
        overallRank: number | null | undefined;
      }>
    | undefined,
  standingsRowExpired: boolean,
): boolean => standingsRowExpired || !isPositiveOverallRank(row?.overallRank);

export const shouldRetryPendingClassicOverallRank = (
  entryId: number,
  standingsPending: boolean,
  baselineMarkers: ReadonlyMap<number, string> | null,
  latestMarkers: ReadonlyMap<number, string> | null,
): boolean => {
  if (standingsPending) return true;
  if (baselineMarkers === null || latestMarkers === null) return true;

  const latestMarker = latestMarkers.get(entryId);
  return latestMarker === undefined || latestMarker === baselineMarkers.get(entryId);
};

type ClassicStandingObservation = Readonly<{
  source: string;
  checkedAt?: string;
  upstreamUpdatedAt?: string | null;
  eventPoints?: number | null;
  netEventPoints?: number | null;
  totalPoints?: number | null;
  totalScope?: string;
  eventRank?: number | null;
  leagueRank?: number | null;
  transferCost?: number | null;
  eventPointSemantics?: string;
}>;

const classicStandingPhaseChanged = (
  row: ClassicStandingObservation,
  baseline: ClassicStandingObservation,
): boolean =>
  row.upstreamUpdatedAt !== baseline.upstreamUpdatedAt ||
  row.eventPoints !== baseline.eventPoints ||
  row.netEventPoints !== baseline.netEventPoints ||
  row.totalPoints !== baseline.totalPoints ||
  row.totalScope !== baseline.totalScope ||
  row.eventRank !== baseline.eventRank ||
  row.leagueRank !== baseline.leagueRank ||
  row.transferCost !== baseline.transferCost ||
  row.eventPointSemantics !== baseline.eventPointSemantics;

export const shouldPreserveClassicStandingForRank = <T extends ClassicStandingObservation>(
  requested: boolean | undefined,
  row: T | undefined,
  // undefined means this is not a fallback publication. null is supplied only
  // after a locked durable read confirms fallback started without a standings
  // row. A concrete row is the fallback-start snapshot.
  fallbackBaseline?: T | null,
): row is T & { source: 'FPL_CLASSIC_STANDINGS' } => {
  if (row?.source !== 'FPL_CLASSIC_STANDINGS') return false;
  if (requested === true) return true;
  if (fallbackBaseline === undefined) return false;
  if (fallbackBaseline === null || fallbackBaseline.source !== 'FPL_CLASSIC_STANDINGS') return true;

  const rowCheckedAt = Date.parse(row.checkedAt ?? '');
  const baselineCheckedAt = Date.parse(fallbackBaseline.checkedAt ?? '');
  if (Number.isFinite(rowCheckedAt) && Number.isFinite(baselineCheckedAt)) {
    if (rowCheckedAt > baselineCheckedAt) return true;
    if (rowCheckedAt < baselineCheckedAt) return false;
  } else if (Number.isFinite(rowCheckedAt) && !Number.isFinite(baselineCheckedAt)) {
    return true;
  }

  // A same-millisecond standings publication can still carry a newer FPL
  // snapshot or changed phase fields. OR itself is intentionally excluded so
  // a concurrent rank-only enrichment cannot make an old standing look new.
  return classicStandingPhaseChanged(row, fallbackBaseline);
};

export const planClassicOverallRankRefresh = (
  entryIds: readonly number[],
  foregroundEligibleEntryIds: readonly number[] = entryIds,
): Readonly<{
  entryIds: readonly number[];
  foregroundEntryIds: readonly number[];
}> => {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const requestedEntryIds = new Set(uniqueEntryIds);
  const uniqueForegroundEligibleEntryIds = Array.from(new Set(foregroundEligibleEntryIds)).filter(
    (entryId) => requestedEntryIds.has(entryId),
  );
  return {
    entryIds: uniqueEntryIds,
    foregroundEntryIds: uniqueForegroundEligibleEntryIds.slice(
      0,
      MAX_FOREGROUND_OVERALL_RANK_FETCHES,
    ),
  };
};

export const pendingOverallRankRefreshEntryIds = (
  requestedEntryIds: readonly number[],
  refreshedEntryIds: readonly number[],
): readonly number[] => {
  const refreshed = new Set(refreshedEntryIds);
  return requestedEntryIds.filter((entryId) => !refreshed.has(entryId));
};
export const createManagerSummaryFetchGate = (
  maxConcurrent = MAX_SUMMARY_FETCH_CONCURRENCY,
): (<T>(
  task: () => Promise<T>,
  priority?: ManagerSummaryFetchPriority,
  coalesceKey?: string | number,
) => Promise<T>) => {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }

  type FetchWaiter = {
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    priority: ManagerSummaryFetchPriority;
    coalesceKey: string | number | undefined;
    started: boolean;
  };

  let active = 0;
  const foregroundWaiters: FetchWaiter[] = [];
  const backgroundWaiters: FetchWaiter[] = [];
  const keyed = new Map<string | number, { waiter: FetchWaiter; promise: Promise<unknown> }>();

  const startNext = (): void => {
    while (active < maxConcurrent) {
      const waiter = foregroundWaiters.shift() ?? backgroundWaiters.shift();
      if (!waiter) return;
      waiter.started = true;
      active += 1;
      void Promise.resolve()
        .then(waiter.task)
        .finally(() => {
          active -= 1;
          if (
            waiter.coalesceKey !== undefined &&
            keyed.get(waiter.coalesceKey)?.waiter === waiter
          ) {
            keyed.delete(waiter.coalesceKey);
          }
          startNext();
        })
        .then(waiter.resolve, waiter.reject);
    }
  };

  return <T>(
    task: () => Promise<T>,
    priority: ManagerSummaryFetchPriority = 'foreground',
    coalesceKey?: string | number,
  ): Promise<T> => {
    if (coalesceKey !== undefined) {
      const existing = keyed.get(coalesceKey);
      if (existing) {
        if (
          priority === 'foreground' &&
          !existing.waiter.started &&
          existing.waiter.priority === 'background'
        ) {
          const queuedIndex = backgroundWaiters.indexOf(existing.waiter);
          if (queuedIndex >= 0) backgroundWaiters.splice(queuedIndex, 1);
          existing.waiter.priority = 'foreground';
          foregroundWaiters.push(existing.waiter);
        }
        return existing.promise as Promise<T>;
      }
    }

    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const waiter: FetchWaiter = {
      task,
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
      priority,
      coalesceKey,
      started: false,
    };
    if (coalesceKey !== undefined) keyed.set(coalesceKey, { waiter, promise });
    (priority === 'foreground' ? foregroundWaiters : backgroundWaiters).push(waiter);
    startNext();
    return promise;
  };
};

export const managerSummaryFetchBatches = (
  entryIds: readonly number[],
): readonly (readonly number[])[] => {
  const batches: number[][] = [];
  for (let offset = 0; offset < entryIds.length; offset += MAX_SUMMARY_FETCH_CONCURRENCY) {
    batches.push(entryIds.slice(offset, offset + MAX_SUMMARY_FETCH_CONCURRENCY));
  }
  return batches;
};

export const planClassicManagerFallback = (
  pendingColdEntryIds: readonly number[],
  pendingStaleEntryIds: readonly number[],
  standingsComplete: boolean,
): Readonly<{
  foregroundSummaryEntryIds: readonly number[];
  backgroundStandingsEntryIds: readonly number[];
  backgroundSummaryEntryIds: readonly number[];
}> => ({
  // Once standings pagination is exhausted, a roster member can still be in
  // FPL's new-entries lane. Use the official entry summary instead of leaving
  // that cold manager unavailable for the entire gameweek. Existing classic
  // rows remain last-good standings and are never replaced by this fallback.
  foregroundSummaryEntryIds: standingsComplete
    ? pendingColdEntryIds.slice(0, MAX_FOREGROUND_SUMMARY_FETCHES)
    : [],
  // A stale classic row must be refreshed from standings even when a separate
  // cold-target crawl already completed. Cold rows continue standings only
  // when that foreground crawl did not exhaust the league.
  backgroundStandingsEntryIds: [
    ...pendingStaleEntryIds,
    ...(standingsComplete ? [] : pendingColdEntryIds),
  ],
  backgroundSummaryEntryIds: standingsComplete ? pendingColdEntryIds : [],
});

export const managerLiveBackgroundRefreshKey = (
  prefix: string,
  entryIds: readonly number[],
): string =>
  `${prefix}:${Array.from(new Set(entryIds))
    .sort((left, right) => left - right)
    .join(',')}`;

export const rotateManagerLiveEntryIds = (
  entryIds: readonly number[],
  offset: number,
  limit: number,
): readonly number[] => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('offset must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a non-negative safe integer');
  }
  if (entryIds.length === 0 || limit === 0) return [];

  const start = offset % entryIds.length;
  return Array.from(
    { length: Math.min(limit, entryIds.length) },
    (_, index) => entryIds[(start + index) % entryIds.length]!,
  );
};

export const classicManagerSummaryFallbackEntryIds = (
  directSummaryEntryIds: readonly number[],
  standingsEntryIds: readonly number[],
  coldEntryIds: ReadonlySet<number>,
  staleSummaryEntryIds: ReadonlySet<number>,
  standingsComplete: boolean,
): readonly number[] =>
  Array.from(
    new Set([
      ...directSummaryEntryIds,
      ...(standingsComplete
        ? standingsEntryIds.filter(
            (entryId) => coldEntryIds.has(entryId) || staleSummaryEntryIds.has(entryId),
          )
        : []),
    ]),
  );

export const classicManagerSummaryFallbackNeedsRefresh = (
  row: Readonly<{ source: string }> | undefined,
  fresh: boolean,
): boolean => !row || (row.source === 'FPL_ENTRY_SUMMARY' && !fresh);
