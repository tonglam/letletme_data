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
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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

    it('should set and get a single player value', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const playerValueCache = createPlayerValueCache(
        redis,
        {
          getOne: async () => null,
          getAll: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
        },
      );

      const testPlayerValue = testPlayerValues[0];
      const cacheResult = await pipe(playerValueCache.cachePlayerValue(testPlayerValue))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(
        playerValueCache.getPlayerValue(testPlayerValue.id.toString()),
      )();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerValue(getResult.right, testPlayerValue)).toBe(true);
      }
    });

    it('should set and get multiple player values', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const playerValueCache = createPlayerValueCache(
        redis,
        {
          getOne: async () => null,
          getAll: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
        },
      );

      const cacheResult = await pipe(playerValueCache.cachePlayerValues(testPlayerValues))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        const cachedPlayerValues = getResult.right;
        expect(comparePlayerValueArrays(cachedPlayerValues, testPlayerValues)).toBe(true);
      }
    });

    it('should handle cache miss with data provider fallback', async () => {
      // Clear the cache before starting the test
      const cacheKey = `${TEST_PREFIX}::${TEST_SEASON}`;
      const keys = await redisClient.keys(`${cacheKey}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const testPlayerValue = testPlayerValues[0];
      const mockDataProvider = {
        getOne: jest.fn().mockImplementation(async (id: string) => {
          const playerValue = testPlayerValues.find((e) => e.id === id);
          return playerValue || null;
        }),
        getAll: jest.fn().mockImplementation(async () => {
          // Return a copy of testPlayerValues to avoid mutation
          return [...testPlayerValues];
        }),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test cache miss for single player value
      const getResult = await pipe(
        playerValueCache.getPlayerValue(testPlayerValue.id.toString()),
      )();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerValue(getResult.right, testPlayerValue)).toBe(true);
        expect(mockDataProvider.getOne).toHaveBeenCalledWith(testPlayerValue.id);
      }

      // Clear the cache before testing getAllPlayerValues
      const allKeys = await redisClient.keys(`${cacheKey}*`);
      if (allKeys.length > 0) {
        await redisClient.del(allKeys);
      }

      // Test cache miss for all player values
      const getAllResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getAllResult)).toBe(true);
      if (E.isRight(getAllResult) && getAllResult.right) {
        const cachedPlayerValues = getAllResult.right;
        expect(cachedPlayerValues.length).toBe(testPlayerValues.length);
        expect(comparePlayerValueArrays(cachedPlayerValues, testPlayerValues)).toBe(true);
        expect(mockDataProvider.getAll).toHaveBeenCalled();

        // Verify that player values are properly cached
        const verifyResult = await pipe(playerValueCache.getAllPlayerValues())();
        expect(E.isRight(verifyResult)).toBe(true);
        if (E.isRight(verifyResult) && verifyResult.right) {
          expect(verifyResult.right.length).toBe(testPlayerValues.length);
          expect(comparePlayerValueArrays(verifyResult.right, testPlayerValues)).toBe(true);
          // getAll should not be called again
          expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
        }
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getAll: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test error handling for single player value
      const getResult = await pipe(playerValueCache.getPlayerValue('1'))();
      expect(E.isLeft(getResult)).toBe(true);

      // Test error handling for all player values
      const getAllResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isLeft(getAllResult)).toBe(true);
    });

    it('should warm up cache with initial data', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue(testPlayerValues),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Warm up cache
      const warmUpResult = await pipe(playerValueCache.warmUp())();
      expect(E.isRight(warmUpResult)).toBe(true);
      expect(mockDataProvider.getAll).toHaveBeenCalled();

      // Verify data is cached
      const getResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerValueArrays(getResult.right, testPlayerValues)).toBe(true);
        // Should not call data provider again
        expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
      }
    });

    it('should handle different seasons and key prefixes', async () => {
      const customPrefix = CachePrefix.PLAYER_VALUE;
      const customSeason = '2024';
      const redis = createRedisCache<PlayerValue>({ keyPrefix: customPrefix });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPlayerValues[0]),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: customPrefix,
        season: customSeason,
      });

      // Cache multiple player values to test multi command
      const cacheResult = await pipe(
        playerValueCache.cachePlayerValues([testPlayerValues[0], testPlayerValues[1]]),
      )();
      expect(E.isRight(cacheResult)).toBe(true);

      // Verify the player values are stored in Redis with correct key
      const key = `${customPrefix}::${customSeason}`;
      const values = await redisClient.hgetall(key);
      expect(values).toBeTruthy();
      expect(Object.keys(values).length).toBe(2);

      // Verify we can retrieve them through the cache
      const getResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(getResult.right.length).toBe(2);
        expect(
          comparePlayerValueArrays(getResult.right, [testPlayerValues[0], testPlayerValues[1]]),
        ).toBe(true);
      }
    });

    it('should handle empty player value data gracefully', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test caching empty array
      const cacheResult = await pipe(playerValueCache.cachePlayerValues([]))();
      expect(E.isRight(cacheResult)).toBe(true);

      // Test getting player values when cache is empty
      const getResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle malformed player value data', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const key = `${TEST_PREFIX}::${TEST_SEASON}`;

      // Manually insert malformed data
      await redisClient.hset(key, '999', 'invalid-json');

      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test getting all player values with malformed data
      const getResult = await pipe(playerValueCache.getAllPlayerValues())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        // Malformed data should be filtered out
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle concurrent cache operations', async () => {
      const redis = createRedisCache<PlayerValue>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPlayerValues[0]),
        getAll: jest.fn().mockResolvedValue(testPlayerValues),
      };

      const playerValueCache = createPlayerValueCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Perform multiple cache operations concurrently
      const [cacheResult, getAllResult] = await Promise.all([
        playerValueCache.cachePlayerValue(testPlayerValues[0])(),
        playerValueCache.getAllPlayerValues()(),
      ]);

      // Verify each operation succeeded
      expect(E.isRight(cacheResult)).toBe(true);
      expect(E.isRight(getAllResult)).toBe(true);
    });
  });
});
