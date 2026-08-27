import { describe, expect, test } from 'bun:test';

import {
  isExplicitEntryRepairRequest,
  planEventEligibleEntrySyncWork,
  resolveFinalizationFreshAfter,
  resolveEntrySyncTargetEventId,
  resolveRichResultFreshnessCutoff,
  shouldRefreshEntryInfoFromSource,
  shouldRefreshEntryPicks,
} from '../../src/domain/entry-sync';

describe('explicit entry repair selection', () => {
  test('skips entries that started after the target event without hiding unknown metadata', () => {
    expect(
      planEventEligibleEntrySyncWork(
        [101, 102, 103, 104],
        [
          { id: 101, startedEvent: 1 },
          { id: 102, startedEvent: 2 },
          { id: 103, startedEvent: null },
        ],
        1,
      ),
    ).toEqual({
      eligibleEntryIds: [101, 103, 104],
      skippedUnits: 1,
    });
  });

  test('distinguishes targeted repair lists from scheduled scans', () => {
    expect(isExplicitEntryRepairRequest({ entryIds: [1, 2] })).toBe(true);
    expect(isExplicitEntryRepairRequest({ entryIds: [] })).toBe(true);
    expect(isExplicitEntryRepairRequest({})).toBe(false);
    expect(isExplicitEntryRepairRequest(undefined)).toBe(false);
  });

  test('refreshes scheduled and explicit entry-info jobs from the upstream source', () => {
    expect(shouldRefreshEntryInfoFromSource({ source: 'cron' })).toBe(true);
    expect(shouldRefreshEntryInfoFromSource({ source: 'catchup', obligationId: 'daily-1' })).toBe(
      true,
    );
    expect(shouldRefreshEntryInfoFromSource({ source: 'manual' })).toBe(true);
    expect(shouldRefreshEntryInfoFromSource({ source: 'api', entryIds: [42] })).toBe(true);
    expect(shouldRefreshEntryInfoFromSource({ source: 'catchup' })).toBe(false);
    expect(shouldRefreshEntryInfoFromSource({ source: 'reconcile' })).toBe(false);
    expect(
      shouldRefreshEntryInfoFromSource({ source: 'catchup', entryIds: [42], retryCount: 1 }),
    ).toBe(false);
    expect(
      shouldRefreshEntryInfoFromSource({ source: 'reconcile', entryIds: [42], retryCount: 1 }),
    ).toBe(false);
    expect(
      shouldRefreshEntryInfoFromSource({
        source: 'catchup',
        entryIds: [42],
        retryCount: 1,
        obligationId: 'daily-1',
      }),
    ).toBe(true);
  });

  test('refreshes picks for every cron run and explicit repair', () => {
    expect(shouldRefreshEntryPicks({ source: 'cron' })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'cron', entryIds: [42] })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'api', entryIds: [42] })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'manual' })).toBe(false);
  });
});

describe('entry sync target event resolution', () => {
  test('preserves explicit event IDs without a lookup', async () => {
    let lookups = 0;
    const eventId = await resolveEntrySyncTargetEventId('entry-results', 7, async () => {
      lookups += 1;
      return 8;
    });

    expect(eventId).toBe(7);
    expect(lookups).toBe(0);
  });

  test('resolves one current event for event-scoped jobs without a target', async () => {
    expect(await resolveEntrySyncTargetEventId('entry-picks', undefined, async () => 9)).toBe(9);
    expect(await resolveEntrySyncTargetEventId('entry-transfers', undefined, async () => 9)).toBe(
      9,
    );
    expect(await resolveEntrySyncTargetEventId('entry-results', undefined, async () => 9)).toBe(9);
  });

  test('leaves entry-info unscoped and fails when no current event exists', async () => {
    expect(
      await resolveEntrySyncTargetEventId('entry-info', undefined, async () => 9),
    ).toBeUndefined();
    await expect(
      resolveEntrySyncTargetEventId('entry-results', undefined, async () => null),
    ).rejects.toThrow('No current event found');
  });
});

describe('rich result finalization cutoff', () => {
  const checkedAt = new Date('2026-08-04T10:00:00.000Z');

  test('uses only the stable timestamp of a finalized event', () => {
    expect(
      resolveRichResultFreshnessCutoff({
        finished: true,
        dataChecked: true,
        dataCheckedAt: checkedAt,
      }),
    ).toBe(checkedAt);
  });

  test('serializes the finalized source fence for replay freshness', () => {
    expect(
      resolveFinalizationFreshAfter({
        finished: true,
        dataChecked: true,
        dataCheckedAt: checkedAt,
      }),
    ).toBe('2026-08-04T10:00:00.000Z');
  });

  test('returns no replay fence for an active or malformed event', () => {
    expect(resolveFinalizationFreshAfter(null)).toBeNull();
    expect(
      resolveFinalizationFreshAfter({
        finished: true,
        dataChecked: true,
        dataCheckedAt: null,
      }),
    ).toBeNull();
  });

  test('keeps active, unchecked, and uncheckpointed events refreshable', () => {
    expect(resolveRichResultFreshnessCutoff(null)).toBeNull();
    expect(
      resolveRichResultFreshnessCutoff({
        finished: false,
        dataChecked: true,
        dataCheckedAt: checkedAt,
      }),
    ).toBeNull();
    expect(
      resolveRichResultFreshnessCutoff({
        finished: true,
        dataChecked: false,
        dataCheckedAt: checkedAt,
      }),
    ).toBeNull();
    expect(
      resolveRichResultFreshnessCutoff({
        finished: true,
        dataChecked: true,
        dataCheckedAt: null,
      }),
    ).toBeNull();
  });
});
