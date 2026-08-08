import { describe, expect, test } from 'bun:test';

import { isEntryPicksPayloadForEvent } from '../../src/domain/entry-picks';

describe('entry picks payload identity', () => {
  test('accepts only the requested event', () => {
    const payload = { entry_history: { event: 12 } };

    expect(isEntryPicksPayloadForEvent(payload, 12)).toBe(true);
    expect(isEntryPicksPayloadForEvent(payload, 11)).toBe(false);
    expect(isEntryPicksPayloadForEvent({ entry_history: {} }, 12)).toBe(false);
  });
});
