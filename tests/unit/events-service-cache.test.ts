import { describe, expect, test } from 'bun:test';

import type { CoreSnapshotCacheContents } from '../../src/cache/core-snapshot-cache';
import {
  selectCachedCurrentEvent,
  selectCachedEventNeighbour,
} from '../../src/services/events.service';
import type { Event } from '../../src/types';

const event = (id: number, deadline: string, flags: Partial<Event> = {}) =>
  ({ id, deadlineTime: deadline, ...flags }) as Event;

function publication(
  currentEventId: number | null,
  events: Event[],
): Pick<CoreSnapshotCacheContents, 'currentEventId' | 'events' | 'manifest'> {
  return {
    currentEventId,
    events,
    manifest: { sourceCheckedAt: '2026-08-15T12:00:00.000Z' } as never,
  };
}

describe('cached event authority', () => {
  test('uses the deadline-derived current ID instead of lagging upstream flags', () => {
    const cached = publication(2, [
      event(1, '2026-08-08T17:30:00.000Z', { isCurrent: true, isNext: false }),
      event(2, '2026-08-15T10:30:00.000Z', { isCurrent: false, isNext: true }),
      event(3, '2026-08-22T10:30:00.000Z'),
    ]);

    expect(selectCachedCurrentEvent(cached)?.id).toBe(2);
    expect(selectCachedEventNeighbour(cached, -1)?.id).toBe(1);
    expect(selectCachedEventNeighbour(cached, 1)?.id).toBe(3);
  });

  test('uses the first future deadline as the preseason next event', () => {
    const cached = publication(null, [
      event(2, '2026-08-22T10:30:00.000Z', { isNext: true }),
      event(1, '2026-08-16T10:30:00.000Z', { isNext: false }),
    ]);

    expect(selectCachedCurrentEvent(cached)).toBeNull();
    expect(selectCachedEventNeighbour(cached, -1)).toBeNull();
    expect(selectCachedEventNeighbour(cached, 1)?.id).toBe(1);
  });
});
