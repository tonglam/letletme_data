const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;

export type ManagerSummaryFetchPriority = 'foreground' | 'background';

export const preserveClassicOverallRank = (
  incomingOverallRank: number | null,
  existingOverallRank: number | null | undefined,
): number | null =>
  typeof existingOverallRank === 'number' &&
  Number.isSafeInteger(existingOverallRank) &&
  existingOverallRank > 0
    ? existingOverallRank
    : incomingOverallRank;

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
