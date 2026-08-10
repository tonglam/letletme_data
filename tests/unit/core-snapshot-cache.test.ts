import { describe, expect, test } from 'bun:test';

import { selectCurrentEventIdByDeadline } from '../../src/cache/core-snapshot-cache';
import type { Event } from '../../src/types';

function event(id: number, deadlineTime: string | null, isCurrent = false): Event {
  return { id, deadlineTime, isCurrent } as Event;
}

describe('core snapshot current-event authority', () => {
  test('uses the latest elapsed deadline even while the upstream current flag lags', () => {
    const events = [
      event(1, '2026-08-15T10:00:00.000Z', true),
      event(2, '2026-08-22T10:00:00.000Z'),
      event(3, '2026-08-29T10:00:00.000Z'),
    ];

    expect(selectCurrentEventIdByDeadline(events, new Date('2026-08-22T10:00:01.000Z'))).toBe(2);
  });

  test('publishes no current event before the first deadline', () => {
    const events = [event(1, '2026-08-15T10:00:00.000Z', true), event(2, null)];

    expect(selectCurrentEventIdByDeadline(events, new Date('2026-08-14T10:00:00.000Z'))).toBeNull();
  });
});
