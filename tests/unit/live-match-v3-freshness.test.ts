import { describe, expect, test } from 'bun:test';

import { liveMatchStaleAtForCadence } from '../../src/services/live-match-v3.service';

describe('Live Matches V3 freshness policy', () => {
  test('derives freshness only from the shared lifecycle cadence', () => {
    const checkedAt = '2026-08-29T10:00:00.000Z';
    const cases = [
      [30, 75],
      [60, 180],
      [120, 300],
      [300, 720],
      [600, 1500],
      [900, 1800],
      [1800, 3600],
    ] as const;

    for (const [cadenceSeconds, budgetSeconds] of cases) {
      const expectedNextCheckAt = new Date(
        Date.parse(checkedAt) + cadenceSeconds * 1_000,
      ).toISOString();
      expect(
        liveMatchStaleAtForCadence('DAY_SETTLING', checkedAt, expectedNextCheckAt)?.toISOString(),
      ).toBe(new Date(Date.parse(checkedAt) + budgetSeconds * 1_000).toISOString());
    }

    expect(liveMatchStaleAtForCadence('FINALIZED', checkedAt, checkedAt)).toBeNull();
    expect(liveMatchStaleAtForCadence('LIVE_ACTIVE', checkedAt, null)).toBeNull();
  });
});
