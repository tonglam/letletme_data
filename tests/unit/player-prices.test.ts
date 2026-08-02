import { describe, expect, mock, test } from 'bun:test';

import { createPlayerPricesSync } from '../../src/services/player-prices.service';
import type { Player } from '../../src/types';

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

describe('player-prices sync', () => {
  test('updates only risers and fallers and merges their complete cache fields', async () => {
    const updatePrices = mock(async (updates: Array<{ elementId: number; value: number }>) =>
      updates.map((update) => player(update.elementId, update.value)),
    );
    const mergePlayersCache = mock(async () => undefined);
    const sync = createPlayerPricesSync({
      findByChangeDate: async () => [
        stored(1, 50, '20260803', 'Start'),
        stored(2, 61, '20260803', 'Rise'),
        stored(3, 49, '20260803', 'Faller'),
      ],
      findLatestForPlayerIds: async () => [
        stored(2, 61, '20260803', 'Rise'),
        stored(3, 49, '20260803', 'Faller'),
      ],
      updatePrices,
      mergePlayersCache,
    });

    expect(await sync('20260803')).toEqual({ count: 2, changeDate: '20260803' });
    expect(updatePrices).toHaveBeenCalledWith([
      { elementId: 2, value: 61 },
      { elementId: 3, value: 49 },
    ]);
    expect(mergePlayersCache).toHaveBeenCalledTimes(1);
  });

  test('uses each affected player latest value during an old-date replay', async () => {
    const updatePrices = mock(async (updates: Array<{ elementId: number; value: number }>) =>
      updates.map((update) => player(update.elementId, update.value)),
    );
    const sync = createPlayerPricesSync({
      findByChangeDate: async () => [stored(2, 61, '20260803', 'Rise')],
      findLatestForPlayerIds: async () => [stored(2, 63, '20260805', 'Rise')],
      updatePrices,
      mergePlayersCache: async () => undefined,
    });

    await sync('20260803');
    expect(updatePrices).toHaveBeenCalledWith([{ elementId: 2, value: 63 }]);
  });

  test('skips cleanly when a date contains only Start rows', async () => {
    const updatePrices = mock(async () => []);
    const mergePlayersCache = mock(async () => undefined);
    const sync = createPlayerPricesSync({
      findByChangeDate: async () => [stored(1, 50, '20260802', 'Start')],
      findLatestForPlayerIds: async () => [],
      updatePrices,
      mergePlayersCache,
    });

    expect(await sync('20260802')).toEqual({ count: 0, changeDate: '20260802' });
    expect(updatePrices).not.toHaveBeenCalled();
    expect(mergePlayersCache).not.toHaveBeenCalled();
  });
});
