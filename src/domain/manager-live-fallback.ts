const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;
// A Classic board enriches at most 20 managers synchronously. Larger rosters
// keep the same upstream request budget and finish through the background gate.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;

export type ManagerSummaryFetchPriority = 'foreground' | 'background';

export const createKeyedSerialTaskGate = (): (<T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T>) => {
  const tails = new Map<string, Promise<void>>();

  return async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    tails.set(key, turn);

    await previous;
    try {
      return await task();
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

export const shouldPreserveClassicStandingForRank = <T extends Readonly<{ source: string }>>(
  requested: boolean | undefined,
  row: T | undefined,
): row is T & { source: 'FPL_CLASSIC_STANDINGS' } =>
  requested === true && row?.source === 'FPL_CLASSIC_STANDINGS';

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
): (<T>(task: () => Promise<T>, priority?: ManagerSummaryFetchPriority) => Promise<T>) => {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }

  let active = 0;
  const foregroundWaiters: Array<() => void> = [];
  const backgroundWaiters: Array<() => void> = [];

  const acquire = (priority: ManagerSummaryFetchPriority): Promise<void> =>
    new Promise((resolve) => {
      const start = (): void => {
        active += 1;
        resolve();
      };

      if (active < maxConcurrent) {
        start();
      } else {
        (priority === 'foreground' ? foregroundWaiters : backgroundWaiters).push(start);
      }
    });

  return async <T>(
    task: () => Promise<T>,
    priority: ManagerSummaryFetchPriority = 'foreground',
  ): Promise<T> => {
    await acquire(priority);
    try {
      return await task();
    } finally {
      active -= 1;
      // A background crawl may queue hundreds of entries. Once an active
      // permit completes, always admit a request-path refresh first so the
      // desk waits for at most the currently running upstream wave.
      (foregroundWaiters.shift() ?? backgroundWaiters.shift())?.();
    }
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
  pendingEntryIds: readonly number[],
  standingsComplete: boolean,
): Readonly<{
  foregroundSummaryEntryIds: readonly number[];
  backgroundEntryIds: readonly number[];
  continueStandings: boolean;
}> => ({
  // Once standings pagination is exhausted, a roster member can still be in
  // FPL's new-entries lane. Use the official entry summary instead of leaving
  // that manager unavailable for the entire gameweek.
  foregroundSummaryEntryIds: standingsComplete
    ? pendingEntryIds.slice(0, MAX_FOREGROUND_SUMMARY_FETCHES)
    : [],
  backgroundEntryIds: pendingEntryIds,
  continueStandings: !standingsComplete,
});
