import { describe, expect, mock, test } from 'bun:test';

import type { StoredPlayerValue } from '../../src/repositories/player-values';
import {
  createPlayerValuesSync,
  type PlayerValuesSyncDependencies,
} from '../../src/services/player-values.service';
import { singleRawFPLElementFixture } from '../fixtures/player-values.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const changeDate = '20260803';
const captureTime = new Date('2026-08-03T01:00:00.000Z');
const rawTeam = {
  id: singleRawFPLElementFixture.team,
  name: 'Manchester City',
  short_name: 'MCI',
};

function storedValue(
  changeType: StoredPlayerValue['changeType'],
  value = singleRawFPLElementFixture.now_cost,
  lastValue = value - 1,
): StoredPlayerValue {
  return {
    elementId: singleRawFPLElementFixture.id,
    elementType: singleRawFPLElementFixture.element_type,
    eventId: 1,
    value,
    changeDate,
    changeType,
    lastValue,
  };
}

function buildDependencies(
  overrides: Partial<PlayerValuesSyncDependencies> = {},
): PlayerValuesSyncDependencies {
  return {
    getBootstrap: async () =>
      ({ elements: [singleRawFPLElementFixture], teams: [rawTeam] }) as never,
    resolvePlayerSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
    persistMarketSnapshot: async (_season, _eventId, snapshots) => ({
      snapshotDate: '2026-08-03',
      persistedCount: snapshots.length,
    }),
    findByChangeDate: async () => [],
    enqueuePlayerPrices: async () => ({ id: 'player-prices-immediate' }) as never,
    notify: async () => undefined,
    getCurrentChangeDate: () => changeDate,
    now: () => captureTime,
    ...overrides,
  };
}

describe('daily player market snapshot synchronization', () => {
  test('discards a delayed capture without any upstream or database read', async () => {
    const getBootstrap = mock(async () => ({ elements: [] }) as never);
    const resolvePlayerSyncEvent = mock(async () => null);
    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap,
        resolvePlayerSyncEvent,
        getCurrentChangeDate: () => '20260804',
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toEqual({ count: 0, outcome: 'noop' });
    expect(resolvePlayerSyncEvent).not.toHaveBeenCalled();
    expect(getBootstrap).not.toHaveBeenCalled();
  });

  test('reports the explicit target before a later upstream failure', async () => {
    const resolvedEvents: number[] = [];
    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap: async () => {
          throw new Error('bootstrap unavailable');
        },
      }),
    );

    await expect(
      sync(TEST_SEASON, changeDate, {
        onTargetEventResolved: (eventId) => resolvedEvents.push(eventId),
      }),
    ).rejects.toThrow('bootstrap unavailable');
    expect(resolvedEvents).toEqual([1]);
  });

  test('persists one complete canonical snapshot without writing a second values store', async () => {
    const persistMarketSnapshot = mock(
      async (_season, _eventId, snapshots: readonly unknown[], expectedCount: number) => ({
        snapshotDate: '2026-08-03',
        persistedCount: snapshots.length,
        expectedCount,
      }),
    );
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);
    const notify = mock(async (_message: string) => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({ persistMarketSnapshot, enqueuePlayerPrices, notify }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toEqual({
      count: 0,
      eventId: 1,
      marketSnapshotCount: 1,
    });
    expect(persistMarketSnapshot).toHaveBeenCalledTimes(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[0]).toEqual(TEST_SEASON);
    expect(persistMarketSnapshot.mock.calls[0]?.[1]).toBe(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[2]).toHaveLength(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[3]).toBe(1);
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('derives changed rows from reporting data, then enqueues reconciliation and notifies', async () => {
    const enqueuePlayerPrices = mock(async () => ({ id: 'prices' }) as never);
    const notify = mock(async (_message: string) => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Rise')],
        enqueuePlayerPrices,
        notify,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({
      count: 1,
      eventId: 1,
      marketSnapshotCount: 1,
    });
    expect(enqueuePlayerPrices).toHaveBeenCalledWith(TEST_SEASON, 'cascade', {
      changeDate,
      jobId: `player-prices-${changeDate}-immediate`,
      removeOnSettle: true,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain('Haaland (MCI)');
  });

  test('does not treat Start rows as a price change', async () => {
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Start', 142, 0)],
        enqueuePlayerPrices,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({ count: 0 });
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
  });

  test('rejects a persisted snapshot whose canonical calendar day differs', async () => {
    const findByChangeDate = mock(async () => []);
    const sync = createPlayerValuesSync(
      buildDependencies({
        persistMarketSnapshot: async () => ({
          snapshotDate: '2026-08-02',
          persistedCount: 1,
        }),
        findByChangeDate,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).rejects.toThrow(
      'Market snapshot date 2026-08-02 does not match requested date 20260803',
    );
    expect(findByChangeDate).not.toHaveBeenCalled();
  });

  test('notification failure does not invalidate a complete canonical capture', async () => {
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Faller', 140, 141)],
        notify: async () => {
          throw new Error('notification unavailable');
        },
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({ count: 1 });
  });
});
