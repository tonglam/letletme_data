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
    countCurrentUpstreamPlayers: async () => 581,
    getDayCoverage: async () => ({
      snapshotCount: 581,
      captureCount: 1,
      latestCapturedAt: new Date('2026-08-13T01:30:00.000Z'),
    }),
    hasChangesForDate: async () => false,
    waitForPlayerValuesSettlement: async () => ({ settled: true, state: 'removed' }),
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
      phase: 'preseason',
      expectedCount: 581,
      snapshotCount: 581,
      captureCount: 1,
      latestCapturedAt: '2026-08-13T01:30:00.000Z',
      hasChanges: false,
      queueState: 'removed',
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test('carries the exact governance window and source run into publication', async () => {
    const ensureMarketPublication = mock(async () => ({ status: 'published' as const }));
    await expect(
      checkPlayerMarketFreshness(now, dependencies({ ensureMarketPublication }), {
        freshnessWindowId: 42,
        sourceRunId: 'scheduler-run-42',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(ensureMarketPublication).toHaveBeenCalledWith(TEST_SEASON, {
      freshnessWindowId: 42,
      sourceRunId: 'scheduler-run-42',
    });
  });

  test('uses the current bootstrap roster rather than the accumulated players table', async () => {
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        countCurrentUpstreamPlayers: async () => 580,
        getDayCoverage: async () => ({
          snapshotCount: 580,
          captureCount: 1,
          latestCapturedAt: new Date('2026-08-13T01:30:00.000Z'),
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'ready', expectedCount: 580, snapshotCount: 580 });
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

  test('requires a final-window capture when the current-event poll found no changes', async () => {
    const notify = mock(async (_message: string) => undefined);
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
        notify,
      }),
    );

    expect(result).toMatchObject({ status: 'stale', phase: 'current', hasChanges: false });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('accepts an earlier current-event capture once price changes are persisted', async () => {
    await expect(
      checkPlayerMarketFreshness(
        now,
        dependencies({
          resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
          hasChangesForDate: async () => true,
        }),
      ),
    ).resolves.toMatchObject({ status: 'ready', phase: 'current', hasChanges: true });
  });

  test('accepts a zero-change current-event snapshot captured at the end of the window', async () => {
    await expect(
      checkPlayerMarketFreshness(
        now,
        dependencies({
          resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
          getDayCoverage: async () => ({
            snapshotCount: 581,
            captureCount: 1,
            latestCapturedAt: new Date('2026-08-13T01:35:00.000Z'),
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: 'ready', phase: 'current', hasChanges: false });
  });

  test('waits for the deterministic capture and alerts only after its retry horizon times out', async () => {
    const order: string[] = [];
    const notify = mock(async (_message: string) => undefined);
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        waitForPlayerValuesSettlement: async () => {
          order.push('settlement');
          return { settled: false, state: 'delayed' };
        },
        getDayCoverage: async () => {
          order.push('coverage');
          return { snapshotCount: 573, captureCount: 1, latestCapturedAt: now };
        },
        notify,
      }),
    );

    expect(order).toEqual(['coverage', 'settlement', 'coverage']);
    expect(result).toMatchObject({ status: 'unsettled', queueState: 'delayed' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('does not treat a not-yet-enqueued 09:35 capture as settled', async () => {
    let missingIsSettled: boolean | undefined;
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
        waitForPlayerValuesSettlement: async (_season, _date, options) => {
          missingIsSettled = options.missingIsSettled;
          return { settled: false, state: 'not-observed' };
        },
      }),
    );

    expect(missingIsSettled).toBe(false);
    expect(result).toMatchObject({ status: 'unsettled', queueState: 'not-observed' });
  });

  test('accepts durable final-capture evidence when a fast queue job was never observed', async () => {
    const result = await checkPlayerMarketFreshness(
      now,
      dependencies({
        resolveSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
        getDayCoverage: async () => ({
          snapshotCount: 581,
          captureCount: 1,
          latestCapturedAt: new Date('2026-08-13T01:35:00.000Z'),
        }),
        waitForPlayerValuesSettlement: async () => ({
          settled: false,
          state: 'not-observed',
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'ready', queueState: 'not-observed' });
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
