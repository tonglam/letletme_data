import { describe, expect, test } from 'bun:test';

import {
  eventLiveHeartbeatIsFresh,
  eventLivePicksAreFresh,
  eventLiveProjectedPicksAreCoherent,
  hasCompleteAggregateCoverage,
} from '../../src/services/event-live-v2-score.service';

describe('Live Points V2 freshness boundaries', () => {
  test('treats provider heartbeat and entry picks as separate budgets', () => {
    const heartbeat = '2026-08-24T00:01:00.000Z';
    expect(eventLiveHeartbeatIsFresh(heartbeat, Date.parse(heartbeat) + 90_000)).toBe(true);
    expect(eventLiveHeartbeatIsFresh(heartbeat, Date.parse(heartbeat) + 90_001)).toBe(false);
    expect(eventLivePicksAreFresh('2026-08-24T00:00:00.000Z', heartbeat)).toBe(true);
    expect(eventLivePicksAreFresh('2026-08-23T23:44:59.000Z', heartbeat)).toBe(false);
  });

  test('allows a coherent older picks publication to remain usable', () => {
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-23T00:00:00.000Z', '2026-08-24T00:01:00.000Z'),
    ).toBe(true);
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-24T00:02:00.000Z', '2026-08-24T00:01:00.000Z'),
    ).toBe(false);
  });

  test('requires complete contiguous aggregate coverage', () => {
    expect(
      hasCompleteAggregateCoverage({ eventCount: 3, firstEventId: 2, lastEventId: 4 }, 2, 4),
    ).toBe(true);
    expect(
      hasCompleteAggregateCoverage({ eventCount: 2, firstEventId: 2, lastEventId: 4 }, 2, 4),
    ).toBe(false);
    expect(hasCompleteAggregateCoverage(undefined, 1, 1)).toBe(false);
  });
});
