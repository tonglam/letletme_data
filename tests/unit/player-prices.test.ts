import { describe, expect, mock, test } from 'bun:test';

import {
  createPlayerPricesSync,
  type PlayerPricesSyncDependencies,
} from '../../src/services/player-prices.service';
import type { Player } from '../../src/types';
import { singleRawFPLElementFixture } from '../fixtures/player-values.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const sourceCheckedAt = new Date('2026-08-04T00:00:00.000Z');

const stored = (
  elementId: number,
  value: number,
  changeDate: string,
  changeType: 'Start' | 'Rise' | 'Faller',
) => ({
  elementId,
  value,
  changeDate,
  changeType,
  eventId: 1,
  elementType: 3,
  lastValue: changeType === 'Start' ? 0 : value - 1,
});

const player = (id: number, price: number): Player => ({
  id,
  code: id + 1000,
  type: 3,
  teamId: 1,
  price,
  startPrice: 50,
  firstName: `First ${id}`,
  secondName: `Last ${id}`,
  webName: `Player ${id}`,
});

const bootstrap = (ids: number[]) =>
  ({
    elements: ids.map((id) => ({
      ...singleRawFPLElementFixture,
      id,
      code: singleRawFPLElementFixture.code + id,
      first_name: `First ${id}`,
      second_name: `Last ${id}`,
      web_name: `Player ${id}`,
    })),
    events: [{ id: 1, deadline_time: '2026-08-15T17:30:00Z' }],
  }) as never;

function dependencies(
  overrides: Partial<PlayerPricesSyncDependencies> = {},
): PlayerPricesSyncDependencies {
  return {
    findByChangeDate: async () => [],
    findLatestForPlayerIds: async () => [],
    getBootstrap: async () => bootstrap([1]),
    updatePrices: async () => [],
    enqueueCoreSnapshot: async () => ({ id: 'core' }) as never,
    readOrderingTimestamp: async () => sourceCheckedAt,
    ...overrides,
  };
}

describe('player price reconciliation', () => {
  test('updates only changed players with the latest in-season value and rebuilds core', async () => {
    const updatePrices = mock(
      async (_season, updates: Array<{ elementId: number; value: number }>) =>
        updates.map((update) => player(update.elementId, update.value)),
    );
    const findLatestForPlayerIds = mock(async () => [
      stored(2, 63, '20260805', 'Rise'),
      stored(3, 47, '20260805', 'Faller'),
    ]);
    const enqueueCoreSnapshot = mock(async () => ({ id: 'core' }) as never);
    const sync = createPlayerPricesSync(
      dependencies({
        findByChangeDate: async () => [
          stored(1, 50, '20260803', 'Start'),
          stored(2, 61, '20260803', 'Rise'),
          stored(3, 49, '20260803', 'Faller'),
        ],
        findLatestForPlayerIds,
        getBootstrap: async () => bootstrap([1, 2, 3]),
        updatePrices,
        enqueueCoreSnapshot,
      }),
    );

    await expect(sync(TEST_SEASON, '20260803')).resolves.toEqual({
      count: 2,
      changeDate: '20260803',
    });
    expect(findLatestForPlayerIds).toHaveBeenCalledWith(
      TEST_SEASON,
      [2, 3],
      '20260601',
      '20270601',
      sourceCheckedAt,
    );
    expect(updatePrices).toHaveBeenCalledWith(
      TEST_SEASON,
      [
        { elementId: 2, value: 63 },
        { elementId: 3, value: 47 },
      ],
      sourceCheckedAt,
    );
    expect(enqueueCoreSnapshot).toHaveBeenCalledWith(TEST_SEASON, 'cascade', {
      jobId: 'core-after-price-20260803',
      removeOnSettle: false,
    });
  });

  test('does no upstream work for a date containing only Start rows', async () => {
    const getBootstrap = mock(async () => bootstrap([1]));
    const readOrderingTimestamp = mock(async () => sourceCheckedAt);
    const sync = createPlayerPricesSync(
      dependencies({
        findByChangeDate: async () => [stored(1, 50, '20260802', 'Start')],
        getBootstrap,
        readOrderingTimestamp,
      }),
    );

    await expect(sync(TEST_SEASON, '20260802')).resolves.toEqual({
      count: 0,
      changeDate: '20260802',
    });
    expect(readOrderingTimestamp).not.toHaveBeenCalled();
    expect(getBootstrap).not.toHaveBeenCalled();
  });

  test('ignores historical changes for players outside the current published roster', async () => {
    const findLatestForPlayerIds = mock(async () => []);
    const updatePrices = mock(async () => []);
    const sync = createPlayerPricesSync(
      dependencies({
        findByChangeDate: async () => [stored(2, 61, '20260803', 'Rise')],
        findLatestForPlayerIds,
        getBootstrap: async () => bootstrap([1, 3]),
        updatePrices,
      }),
    );

    await expect(sync(TEST_SEASON, '20260803')).resolves.toEqual({
      count: 0,
      changeDate: '20260803',
    });
    expect(findLatestForPlayerIds).not.toHaveBeenCalled();
    expect(updatePrices).not.toHaveBeenCalled();
  });

  test('fails closed when a current affected player has no latest canonical value', async () => {
    const updatePrices = mock(async () => []);
    const sync = createPlayerPricesSync(
      dependencies({
        findByChangeDate: async () => [stored(2, 61, '20260803', 'Rise')],
        findLatestForPlayerIds: async () => [],
        getBootstrap: async () => bootstrap([1, 2]),
        updatePrices,
      }),
    );

    await expect(sync(TEST_SEASON, '20260803')).rejects.toThrow(
      'Latest player values missing for IDs: 2',
    );
    expect(updatePrices).not.toHaveBeenCalled();
  });

  test('rebuilds core only for freshness winners', async () => {
    const enqueueCoreSnapshot = mock(async () => ({ id: 'core' }) as never);
    const sync = createPlayerPricesSync(
      dependencies({
        findByChangeDate: async () => [stored(2, 61, '20260803', 'Rise')],
        findLatestForPlayerIds: async () => [stored(2, 63, '20260805', 'Rise')],
        getBootstrap: async () => bootstrap([1, 2]),
        updatePrices: async () => [],
        enqueueCoreSnapshot,
      }),
    );

    await expect(sync(TEST_SEASON, '20260803')).resolves.toEqual({
      count: 0,
      changeDate: '20260803',
    });
    expect(enqueueCoreSnapshot).not.toHaveBeenCalled();
  });
});
