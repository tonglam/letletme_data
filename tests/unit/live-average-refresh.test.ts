import { describe, expect, test } from 'bun:test';

import {
  LIVE_AVERAGE_REFRESH_INTERVAL_MS,
  shouldRefreshLiveAverage,
} from '../../src/services/live-average-refresh.service';

describe('live Average Team refresh policy', () => {
  test('refreshes only when the active core source is older than the live cadence', () => {
    const now = new Date('2026-08-23T18:10:00.000Z');
    expect(LIVE_AVERAGE_REFRESH_INTERVAL_MS).toBe(5 * 60_000);
    expect(shouldRefreshLiveAverage('2026-08-23T18:05:01.000Z', now)).toBe(false);
    expect(shouldRefreshLiveAverage('2026-08-23T18:05:00.000Z', now)).toBe(true);
  });

  test('fails closed when the core source timestamp is absent or invalid', () => {
    const now = new Date('2026-08-23T18:10:00.000Z');
    expect(shouldRefreshLiveAverage(null, now)).toBe(true);
    expect(shouldRefreshLiveAverage('not-a-timestamp', now)).toBe(true);
  });
});
