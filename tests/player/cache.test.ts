import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createPlayerCache } from '../../src/domain/player/cache';
import { toDomainPlayer } from '../../src/domain/player/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import type { ElementResponse } from '../../src/types/element.type';
import type { Player } from '../../src/types/player.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Cache Tests', () => {
  let testPlayers: Player[];
  const TEST_PREFIX = CachePrefix.PLAYER;
  const TEST_SEASON = '2425';

  beforeAll(() => {
    // Convert bootstrap players to domain players
    testPlayers = bootstrapData.elements
      .slice(0, 3)
      .map((player) => toDomainPlayer(player as ElementResponse));
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
    const comparePlayer = (a: Player, b: Player): boolean => {
      return JSON.stringify(a) === JSON.stringify(b);
    };

    const comparePlayerArrays = (a: readonly Player[], b: readonly Player[]): boolean => {
      if (a.length !== b.length) {
        console.log('Length mismatch:', a.length, b.length);
        return false;
      }

      // Sort both arrays by ID for consistent comparison
      const sortedA = [...a].sort((x, y) => Number(x.id) - Number(y.id));
      const sortedB = [...b].sort((x, y) => Number(x.id) - Number(y.id));

      for (let i = 0; i < sortedA.length; i++) {
        if (!comparePlayer(sortedA[i], sortedB[i])) {
          console.log('Mismatch at index', i);
          console.log('Player A:', JSON.stringify(sortedA[i], null, 2));
          console.log('Player B:', JSON.stringify(sortedB[i], null, 2));
          return false;
        }
      }

      return true;
    };

    it('should set and get a single player', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const playerCache = createPlayerCache(
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

      const testPlayer = testPlayers[0];
      const cacheResult = await pipe(playerCache.cachePlayer(testPlayer))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(playerCache.getPlayer(testPlayer.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayer(getResult.right, testPlayer)).toBe(true);
      }
    });

    it('should set and get multiple players', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const playerCache = createPlayerCache(
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

      const cacheResult = await pipe(playerCache.cachePlayers(testPlayers))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        const cachedPlayers = getResult.right;
        expect(comparePlayerArrays(cachedPlayers, testPlayers)).toBe(true);
      }
    });

    it('should handle cache miss with data provider fallback', async () => {
      // Clear the cache before starting the test
      const cacheKey = `${TEST_PREFIX}::${TEST_SEASON}`;
      const keys = await redisClient.keys(`${cacheKey}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const testPlayer = testPlayers[0];
      const mockDataProvider = {
        getOne: jest.fn().mockImplementation(async (id: number) => {
          const player = testPlayers.find((e) => Number(e.id) === id);
          return player || null;
        }),
        getAll: jest.fn().mockImplementation(async () => {
          // Return a copy of testPlayers to avoid mutation
          return [...testPlayers];
        }),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test cache miss for single player
      const getResult = await pipe(playerCache.getPlayer(testPlayer.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayer(getResult.right, testPlayer)).toBe(true);
        expect(mockDataProvider.getOne).toHaveBeenCalledWith(Number(testPlayer.id));
      }

      // Clear the cache before testing getAllPlayers
      const allKeys = await redisClient.keys(`${cacheKey}*`);
      if (allKeys.length > 0) {
        await redisClient.del(allKeys);
      }

      // Test cache miss for all players
      const getAllResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getAllResult)).toBe(true);
      if (E.isRight(getAllResult) && getAllResult.right) {
        const cachedPlayers = getAllResult.right;
        expect(cachedPlayers.length).toBe(testPlayers.length);
        expect(comparePlayerArrays(cachedPlayers, testPlayers)).toBe(true);
        expect(mockDataProvider.getAll).toHaveBeenCalled();

        // Verify that players are properly cached
        const verifyResult = await pipe(playerCache.getAllPlayers())();
        expect(E.isRight(verifyResult)).toBe(true);
        if (E.isRight(verifyResult) && verifyResult.right) {
          expect(verifyResult.right.length).toBe(testPlayers.length);
          expect(comparePlayerArrays(verifyResult.right, testPlayers)).toBe(true);
          // getAll should not be called again
          expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
        }
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getAll: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test error handling for single player
      const getResult = await pipe(playerCache.getPlayer('1'))();
      expect(E.isLeft(getResult)).toBe(true);

      // Test error handling for all players
      const getAllResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isLeft(getAllResult)).toBe(true);
    });

    it('should warm up cache with initial data', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue(testPlayers),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Warm up cache
      const warmUpResult = await pipe(playerCache.warmUp())();
      expect(E.isRight(warmUpResult)).toBe(true);
      expect(mockDataProvider.getAll).toHaveBeenCalled();

      // Verify data is cached
      const getResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerArrays(getResult.right, testPlayers)).toBe(true);
        // Should not call data provider again
        expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
      }
    });

    it('should handle different seasons and key prefixes', async () => {
      const customPrefix = CachePrefix.PLAYER;
      const customSeason = '2024';
      const redis = createRedisCache<Player>({ keyPrefix: customPrefix });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPlayers[0]),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: customPrefix,
        season: customSeason,
      });

      // Cache multiple players to test multi command
      const cacheResult = await pipe(playerCache.cachePlayers([testPlayers[0], testPlayers[1]]))();
      expect(E.isRight(cacheResult)).toBe(true);

      // Verify the players are stored in Redis with correct key
      const key = `${customPrefix}::${customSeason}`;
      const values = await redisClient.hgetall(key);
      expect(values).toBeTruthy();
      expect(Object.keys(values).length).toBe(2);

      // Verify we can retrieve them through the cache
      const getResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(getResult.right.length).toBe(2);
        expect(comparePlayerArrays(getResult.right, [testPlayers[0], testPlayers[1]])).toBe(true);
      }
    });

    it('should handle empty player data gracefully', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test caching empty array
      const cacheResult = await pipe(playerCache.cachePlayers([]))();
      expect(E.isRight(cacheResult)).toBe(true);

      // Test getting players when cache is empty
      const getResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle malformed player data', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const key = `${TEST_PREFIX}::${TEST_SEASON}`;

      // Manually insert malformed data
      await redisClient.hset(key, '999', 'invalid-json');

      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test getting all players with malformed data
      const getResult = await pipe(playerCache.getAllPlayers())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        // Malformed data should be filtered out
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle concurrent cache operations', async () => {
      const redis = createRedisCache<Player>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPlayers[0]),
        getAll: jest.fn().mockResolvedValue(testPlayers),
      };

      const playerCache = createPlayerCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Perform multiple cache operations concurrently
      const [cacheResult, getAllResult] = await Promise.all([
        playerCache.cachePlayer(testPlayers[0])(),
        playerCache.getAllPlayers()(),
      ]);

      // Verify each operation succeeded
      expect(E.isRight(cacheResult)).toBe(true);
      expect(E.isRight(getAllResult)).toBe(true);
    });
  });
});
