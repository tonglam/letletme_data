const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;

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
): Readonly<{
  foregroundEntryIds: readonly number[];
  backgroundEntryIds: readonly number[];
}> => ({
  // Missing rows still need a bounded request-path attempt so a cold cache can
  // return useful data. Existing last-good rows must never wait on FPL.
  foregroundEntryIds: requestedEntryIds.filter((entryId) => !cachedEntryIds.has(entryId)),
  // Background work includes both missing and stale rows, but excludes rows
  // refreshed inside the current freshness window.
  backgroundEntryIds: requestedEntryIds.filter((entryId) => !freshEntryIds.has(entryId)),
});

export const pendingManagerRefreshEntryIds = <T>(
  requestedEntryIds: readonly number[],
  rows: ReadonlyMap<number, T>,
  isFresh: (row: T) => boolean,
): readonly number[] =>
  requestedEntryIds.filter((entryId) => {
    const row = rows.get(entryId);
    return !row || !isFresh(row);
  });

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
