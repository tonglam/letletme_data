import { describe, expect, test } from 'bun:test';

import { decideEntrySyncChain, planEntryInfoSyncWork } from '../../src/domain/entry-sync-chain';

const base = {
  failedUnits: 0,
  retryCount: 0,
  maxRetryCycles: 2,
  fetchedFromDb: true,
  hasMore: false,
  lastEntryId: 50,
};

describe('entry sync keyset chain', () => {
  test('continues a full table chunk from its last stable entry id', () => {
    expect(decideEntrySyncChain({ ...base, hasMore: true })).toEqual({
      action: 'continue_scan',
      afterEntryId: 50,
    });
  });

  test('retries only failed IDs before advancing the table cursor', () => {
    expect(decideEntrySyncChain({ ...base, failedUnits: 2 })).toEqual({
      action: 'retry_failed',
      retryCount: 1,
      resumeAfterEntryId: 50,
    });
    expect(
      decideEntrySyncChain({
        ...base,
        fetchedFromDb: false,
        lastEntryId: null,
        resumeAfterEntryId: 50,
      }),
    ).toEqual({ action: 'continue_scan', afterEntryId: 50 });
  });

  test('fails terminally when the bounded exact-ID retries are exhausted', () => {
    expect(decideEntrySyncChain({ ...base, failedUnits: 1, retryCount: 2 })).toEqual({
      action: 'fail',
    });
  });

  test('marks only a successful final scan chunk complete', () => {
    expect(decideEntrySyncChain(base)).toEqual({ action: 'complete' });
    expect(decideEntrySyncChain({ ...base, fetchedFromDb: false, lastEntryId: null })).toEqual({
      action: 'complete',
    });
  });

  test('reuses rows that already have a canonical database checkpoint', () => {
    expect(planEntryInfoSyncWork([1, 2, 3], [1, 3])).toEqual({
      requiredEntryIds: [1, 3],
      reusedUnits: 1,
    });
  });

  test('refreshes every profile in a scheduled daily scan', () => {
    expect(planEntryInfoSyncWork([1, 2, 3], [], true)).toEqual({
      requiredEntryIds: [1, 2, 3],
      reusedUnits: 0,
    });
  });
});
