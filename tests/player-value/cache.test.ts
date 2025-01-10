import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createPlayerValueCache } from '../../src/domain/player-value/cache';
import { toDomainPlayerValue } from '../../src/domain/player-value/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { ValueChangeType } from '../../src/types/base.type';
import type { ElementResponse } from '../../src/types/element.type';
import { PlayerValue, validatePlayerValueId } from '../../src/types/player-value.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Value Cache Tests', () => {
  let testPlayerValues: PlayerValue[];
  const TEST_PREFIX = CachePrefix.PLAYER_VALUE;
  const TEST_SEASON = '2425';

  beforeAll(() => {
    // Convert bootstrap players to domain player values
    const today = new Date().toISOString().slice(0, 10);
    testPlayerValues = bootstrapData.elements.slice(0, 3).map((player) => {
      const domainValue = toDomainPlayerValue(player as ElementResponse);
      const id = `${player.id}_${today}`;
      const validatedId = pipe(
        id,
        validatePlayerValueId,
        E.getOrElseW(() => {
          throw new Error(`Invalid player value ID: ${id}`);
        }),
      );
      return {
        id: validatedId,
        elementId: player.id,
        elementType: domainValue.elementType,
        eventId: player.event_points,
        value: player.now_cost,
        changeDate: today,
        changeType: ValueChangeType.Start,
        lastValue: player.cost_change_start,
      };
    });
  });

  beforeEach(async () => {
    // Clean up any existing test keys
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(existingKeys);
    }
  });

  afterAll(async () => {
    // Final cleanup
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(existingKeys);
    }
    await redisClient.quit();
  });

  describe('Cache Operations', () => {
    const comparePlayerValue = (a: PlayerValue, b: PlayerValue): boolean => {
      return JSON.stringify(a) === JSON.stringify(b);
    };

    const comparePlayerValueArrays = (
      a: readonly PlayerValue[],
      b: readonly PlayerValue[],
    ): boolean => {
      if (a.length !== b.length) {
        console.log('Length mismatch:', a.length, b.length);
        return false;
      }

      // Sort both arrays by ID for consistent comparison
      const sortedA = [...a].sort((x, y) => x.id.localeCompare(y.id));
      const sortedB = [...b].sort((x, y) => x.id.localeCompare(y.id));

      for (let i = 0; i < sortedA.length; i++) {
        if (!comparePlayerValue(sortedA[i], sortedB[i])) {
          console.log('Mismatch at index', i);
          console.log('Player Value A:', JSON.stringify(sortedA[i], null, 2));
          console.log('Player Value B:', JSON.stringify(sortedB[i], null, 2));
          return false;
        }
      }

      return true;
    };

    it('should find player values by change date with caching', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const changeDate = testPlayerValues[0].changeDate;
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
        getByChangeDate: jest.fn().mockImplementation(async (date: string) => {
          return date === changeDate ? testPlayerValues : [];
        }),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // First call should fetch from data provider
      const firstResult = await pipe(playerValueCache.findByChangeDate(changeDate))();
      expect(E.isRight(firstResult)).toBe(true);
      if (E.isRight(firstResult)) {
        expect(comparePlayerValueArrays(firstResult.right, testPlayerValues)).toBe(true);
        expect(mockDataProvider.getByChangeDate).toHaveBeenCalledWith(changeDate);
      }

      // Second call should fetch from cache
      const secondResult = await pipe(playerValueCache.findByChangeDate(changeDate))();
      expect(E.isRight(secondResult)).toBe(true);
      if (E.isRight(secondResult)) {
        expect(comparePlayerValueArrays(secondResult.right, testPlayerValues)).toBe(true);
        // Data provider should not be called again
        expect(mockDataProvider.getByChangeDate).toHaveBeenCalledTimes(1);
      }

      // Wait for TTL to expire (we can't actually wait 24 hours in a test)
      const cacheKey = `${TEST_PREFIX}::${TEST_SEASON}::change_date::${changeDate}`;
      await redisClient.del(cacheKey);

      // Third call should fetch from data provider again
      const thirdResult = await pipe(playerValueCache.findByChangeDate(changeDate))();
      expect(E.isRight(thirdResult)).toBe(true);
      if (E.isRight(thirdResult)) {
        expect(comparePlayerValueArrays(thirdResult.right, testPlayerValues)).toBe(true);
        expect(mockDataProvider.getByChangeDate).toHaveBeenCalledTimes(2);
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
        getByChangeDate: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      const result = await pipe(playerValueCache.findByChangeDate('2024-01-01'))();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toContain(
          'Failed to get player values by change date from cache',
        );
      }
    });

    it('should handle empty player value data gracefully', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
        getByChangeDate: jest.fn().mockResolvedValue([]),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      const result = await pipe(playerValueCache.findByChangeDate('2024-01-01'))();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual([]);
      }
    });
  });
});
