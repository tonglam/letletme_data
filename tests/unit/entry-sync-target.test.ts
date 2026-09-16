import { describe, expect, test } from 'bun:test';

import {
  isExplicitEntryRepairRequest,
  isReusableEntryPicksHeadForRetry,
  planEventEligibleEntrySyncWork,
  resolveEntrySyncExecutionIntent,
  resolveFinalizationFreshAfter,
  resolveEntrySyncTargetEventId,
  resolveRichResultFreshnessCutoff,
  shouldRefreshEntryInfoFromSource,
  shouldRefreshEntryPicks,
} from '../../src/domain/entry-sync';

describe('explicit entry repair selection', () => {
  test('restores the source intent after a retry continuation', () => {
    expect(resolveEntrySyncExecutionIntent('manual')).toBe('force');
    expect(resolveEntrySyncExecutionIntent('api')).toBe('force');
    expect(resolveEntrySyncExecutionIntent('reconcile')).toBe('reconcile');
    expect(resolveEntrySyncExecutionIntent('catchup')).toBe('reconcile');
    expect(resolveEntrySyncExecutionIntent('cron')).toBe('refresh');
  });

  test('reuses only complete durable picks heads at or after the retry watermark', () => {
    const head = {
      state: 'COMPLETE',
      rowCount: 15,
      sourceCheckedAt: new Date('2026-09-16T10:00:00.000Z'),
      sourceCheckedAtExact: '2026-09-16T10:00:00.123456Z',
    };
    expect(isReusableEntryPicksHeadForRetry(head, '2026-09-16T10:00:00.123000Z')).toBe(true);
    expect(isReusableEntryPicksHeadForRetry(head, '2026-09-16T10:00:01.000Z')).toBe(false);
    expect(
      isReusableEntryPicksHeadForRetry({ ...head, rowCount: 14 }, head.sourceCheckedAtExact),
    ).toBe(false);
    expect(isReusableEntryPicksHeadForRetry(head, undefined)).toBe(false);
  });

  test('reuses a verified immutable FINAL head even when its frozen watermark is older', () => {
    const finalHead = {
      state: 'COMPLETE',
      rowCount: 15,
      sourceCheckedAt: new Date('2026-09-16T10:00:00.000Z'),
      sourceCheckedAtExact: '2026-09-16T10:00:00.123456Z',
      inputPayload: {
        finalResult: {
          revision: 'a'.repeat(64),
          score: { eventPoints: 42, totalPoints: 142 },
          picks: Array.from({ length: 15 }, (_, index) => ({
            element: index + 1,
            position: index + 1,
            multiplier: 1,
            isCaptain: index === 0,
            isViceCaptain: index === 1,
          })),
          automaticSubs: [],
        },
      },
    };
    expect(isReusableEntryPicksHeadForRetry(finalHead, '2026-09-17T10:00:00.000000Z')).toBe(true);
    expect(
      isReusableEntryPicksHeadForRetry(
        { ...finalHead, inputPayload: { ...finalHead.inputPayload, finalResult: null } },
        '2026-09-17T10:00:00.000000Z',
      ),
    ).toBe(false);
  });

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
    expect(isExplicitEntryRepairRequest({ entryIds: [1, 2], retryCount: 1 })).toBe(false);
    expect(isExplicitEntryRepairRequest({ entryIds: [1, 2], executionIntent: 'retry' })).toBe(
      false,
    );
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
    ).toBe(false);
  });

  test('refreshes picks for every cron run and explicit repair', () => {
    expect(shouldRefreshEntryPicks({ source: 'cron' })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'cron', entryIds: [42] })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'api', entryIds: [42] })).toBe(true);
    expect(shouldRefreshEntryPicks({ source: 'manual' })).toBe(false);
    expect(
      shouldRefreshEntryPicks({ source: 'api', entryIds: [42], executionIntent: 'retry' }),
    ).toBe(false);
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
