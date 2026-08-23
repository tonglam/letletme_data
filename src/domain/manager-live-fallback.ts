const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;
// A Classic board enriches at most 20 managers synchronously. Larger rosters
// keep the same upstream request budget and finish through the background gate.
const MAX_FOREGROUND_OVERALL_RANK_FETCHES = 20;

export type ManagerSummaryFetchPriority = 'foreground' | 'background';

export const isPositiveOverallRank = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const preserveLastKnownOverallRank = (
  incoming: number | null | undefined,
  previous: number | null | undefined,
): number | null => {
  if (isPositiveOverallRank(incoming)) return incoming;
  return isPositiveOverallRank(previous) ? previous : null;
};

export const selectLatestCheckedRow = <T extends Readonly<{ checkedAt: string }>>(
  current: T | undefined,
  candidate: T,
): T => {
  if (!current) return candidate;

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
        source: string;
        overallRank: number | null | undefined;
      }>
    | undefined,
  standingsRowExpired: boolean,
): boolean =>
  standingsRowExpired ||
  (row?.source === 'FPL_CLASSIC_STANDINGS' && !isPositiveOverallRank(row.overallRank));

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
