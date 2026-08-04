import { describe, expect, test } from 'bun:test';

import { resolveEntrySyncTargetEventId } from '../../src/domain/entry-sync';

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
