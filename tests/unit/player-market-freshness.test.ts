import { describe, expect, mock, test } from 'bun:test';

import type { PlayerMarketFreshnessDependencies } from '../../src/services/player-market-freshness.service';
import { checkPlayerMarketFreshness } from '../../src/services/player-market-freshness.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const now = new Date('2026-08-13T01:36:00.000Z');

function dependencies(
  overrides: Partial<PlayerMarketFreshnessDependencies> = {},
): PlayerMarketFreshnessDependencies {
  return {
    findCurrentSeason: async () => TEST_SEASON,
    resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'preseason' }) as never,
    countPublishedPlayers: async () => 581,
    getDayCoverage: async () => ({
      snapshotCount: 581,
      captureCount: 1,
      latestCapturedAt: new Date('2026-08-13T01:30:00.000Z'),
    }),
    notify: async () => undefined,
    ...overrides,
  };
}

describe('09:36 player market freshness watchdog', () => {
  test('accepts one complete current-day snapshot without alerting', async () => {
    const notify = mock(async (_message: string) => undefined);
    await expect(checkPlayerMarketFreshness(now, dependencies({ notify }))).resolves.toEqual({
      status: 'ready',
      snapshotDate: '20260813',
      eventId: 1,
      expectedCount: 581,
      snapshotCount: 581,
      captureCount: 1,
      latestCapturedAt: '2026-08-13T01:30:00.000Z',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', 0, 0],
    ['incomplete', 573, 1],
    ['incomplete', 581, 2],
  ] as const)('alerts for a %s day', async (status, snapshotCount, captureCount) => {
    const notify = mock(async (_message: string) => undefined);
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        getDayCoverage: async () => ({
          snapshotCount,
          captureCount,
          latestCapturedAt: snapshotCount ? new Date('2026-08-13T01:30:00.000Z') : null,
        }),
        notify,
      }),
    );

    expect(result.status).toBe(status);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain(`Observed: ${snapshotCount}`);
  });

  test('skips outside an active or scheduled event without reading snapshot data', async () => {
    const getDayCoverage = mock(async () => {
      throw new Error('should not run');
    });
    await expect(
      checkPlayerMarketFreshness(
        now,
        dependencies({ resolveSyncEvent: async () => null, getDayCoverage }),
      ),
    ).resolves.toEqual({ status: 'skipped', reason: 'no-current-or-next-event' });
    expect(getDayCoverage).not.toHaveBeenCalled();
  });

  test('keeps freshness alerts best-effort and independent from readiness', async () => {
    await expect(
      checkPlayerMarketFreshness(
        now,
        dependencies({
          getDayCoverage: async () => ({
            snapshotCount: 0,
            captureCount: 0,
            latestCapturedAt: null,
          }),
          notify: async () => {
            throw new Error('notification unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 'missing' });
  });
});
