import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import {
  ACTIVE_SEASON_KEY,
  resetActiveSeasonMemo,
  withActiveSeasonWriteFence,
} from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';
import type { Player } from '../../src/types';

const SEASON = '0001';
const KEY = `Player:${SEASON}`;

const player = (id: number, teamId: number, price: number): Player => ({
  id,
  code: 10_000 + id,
  type: 3,
  teamId,
  price,
  startPrice: 50,
  firstName: `First ${id}`,
  secondName: `Last ${id}`,
  webName: `Player ${id}`,
});

describe('player cache replacement and price merge atomicity', () => {
  afterAll(async () => {
    const redis = await redisSingleton.getClient();
    await redis.del(KEY);
    await redisSingleton.disconnect();
  });

  test('a stale price job cannot restore removed players or old team identity', async () => {
    await withActiveSeasonWriteFence(async () => {
      const redis = await redisSingleton.getClient();
      const previousActiveSeason = await redis.get(ACTIVE_SEASON_KEY);
      await redis.set(ACTIVE_SEASON_KEY, SEASON);
      resetActiveSeasonMemo();

      try {
        const oldRoster = [player(1, 1, 50), player(2, 1, 60)];
        const reassignedRoster = [player(1, 9, 52), player(2, 1, 60)];
        const replacedRoster = [player(2, 2, 62), player(3, 2, 55)];

        for (let iteration = 0; iteration < 20; iteration += 1) {
          await playersCache.set(oldRoster, SEASON);
          await Promise.allSettled([
            playersCache.mergePrices([{ elementId: 1, value: 51 }], [1, 2], SEASON),
            playersCache.set(reassignedRoster, SEASON),
          ]);

          const reassigned = await playersCache.get(SEASON);
          expect(reassigned?.map(({ id }) => id).sort((left, right) => left - right)).toEqual([
            1, 2,
          ]);
          expect(reassigned?.find(({ id }) => id === 1)).toMatchObject({
            teamId: 9,
            webName: 'Player 1',
          });

          await Promise.allSettled([
            playersCache.mergePrices([{ elementId: 1, value: 53 }], [1, 2], SEASON),
            playersCache.set(replacedRoster, SEASON),
          ]);

          const replaced = await playersCache.get(SEASON);
          expect(replaced?.map(({ id }) => id).sort((left, right) => left - right)).toEqual([2, 3]);
          expect(replaced?.find(({ id }) => id === 1)).toBeUndefined();
          expect(replaced?.find(({ id }) => id === 2)).toMatchObject({ teamId: 2 });
        }
      } finally {
        if (previousActiveSeason === null) {
          await redis.del(ACTIVE_SEASON_KEY);
        } else {
          await redis.set(ACTIVE_SEASON_KEY, previousActiveSeason);
        }
        resetActiveSeasonMemo();
      }
    });
  });
});
