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
  reusedUnits: number;
}

/**
 * Canonical PostgreSQL checkpoints avoid repeated upstream reads. Entry data
 * has no Data Redis publication in v3, so checkpointed rows are simply reused.
 */
export function planEntryInfoSyncWork(
  entryIds: readonly number[],
  snapshotRequiredEntryIds: readonly number[],
  refreshAll = false,
): EntryInfoSyncWorkPlan {
  if (refreshAll) {
    return {
      requiredEntryIds: [...entryIds],
      reusedUnits: 0,
    };
  }
  const requiredSnapshotSet = new Set(snapshotRequiredEntryIds);
  const requiredEntryIds = entryIds.filter((entryId) => requiredSnapshotSet.has(entryId));

  return {
    requiredEntryIds,
    reusedUnits: entryIds.length - requiredEntryIds.length,
  };
}
