const MAX_FOREGROUND_SUMMARY_FETCHES = 4;
const MAX_SUMMARY_FETCH_CONCURRENCY = 4;

export type ManagerSummaryFetchPriority = 'foreground' | 'background';

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
