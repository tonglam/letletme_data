import { describe, expect, test } from 'bun:test';

import {
  isExplicitEntryRepairRequest,
  resolveEntrySyncTargetEventId,
  resolveRichResultFreshnessCutoff,
} from '../../src/domain/entry-sync';

describe('explicit entry repair selection', () => {
  test('distinguishes targeted repair lists from scheduled scans', () => {
    expect(isExplicitEntryRepairRequest({ entryIds: [1, 2] })).toBe(true);
    expect(isExplicitEntryRepairRequest({ entryIds: [] })).toBe(true);
    expect(isExplicitEntryRepairRequest({})).toBe(false);
    expect(isExplicitEntryRepairRequest(undefined)).toBe(false);
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
