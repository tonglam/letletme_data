export type EntrySyncChainDecision =
  | { action: 'retry_failed'; retryCount: number; resumeAfterEntryId?: number }
  | { action: 'continue_scan'; afterEntryId: number }
  | { action: 'complete' }
  | { action: 'fail' };

export function decideEntrySyncChain(input: {
  failedUnits: number;
  retryCount: number;
  maxRetryCycles: number;
  fetchedFromDb: boolean;
  hasMore: boolean;
  lastEntryId: number | null;
  resumeAfterEntryId?: number;
}): EntrySyncChainDecision {
  const continuation = input.fetchedFromDb ? input.lastEntryId : input.resumeAfterEntryId;

  if (input.failedUnits > 0) {
    const retryCount = input.retryCount + 1;
    if (retryCount > input.maxRetryCycles) return { action: 'fail' };
    return {
      action: 'retry_failed',
      retryCount,
      ...(continuation !== null && continuation !== undefined
        ? { resumeAfterEntryId: continuation }
        : {}),
    };
  }

  if (input.resumeAfterEntryId !== undefined) {
    return { action: 'continue_scan', afterEntryId: input.resumeAfterEntryId };
  }
  if (input.fetchedFromDb && input.hasMore && input.lastEntryId !== null) {
    return { action: 'continue_scan', afterEntryId: input.lastEntryId };
  }
  return { action: 'complete' };
}

export interface EntryInfoSyncWorkPlan {
  requiredEntryIds: number[];
  cacheOnlyEntryIds: number[];
  reusedUnits: number;
}

/**
 * Canonical checkpoints avoid repeated upstream reads, but Redis remains
 * derived state. Any checkpointed row missing from the current cache is
 * cache-only work for both ordinary scans and exact-ID retries.
 */
export function planEntryInfoSyncWork(
  entryIds: readonly number[],
  snapshotRequiredEntryIds: readonly number[],
  cachedEntryIds: ReadonlySet<number>,
): EntryInfoSyncWorkPlan {
  const requiredSnapshotSet = new Set(snapshotRequiredEntryIds);
  const cacheOnlyEntryIds = entryIds.filter(
    (entryId) => !requiredSnapshotSet.has(entryId) && !cachedEntryIds.has(entryId),
  );
  const cacheOnlySet = new Set(cacheOnlyEntryIds);
  const requiredEntryIds = entryIds.filter(
    (entryId) => requiredSnapshotSet.has(entryId) || cacheOnlySet.has(entryId),
  );

  return {
    requiredEntryIds,
    cacheOnlyEntryIds,
    reusedUnits: entryIds.length - requiredEntryIds.length,
  };
}
