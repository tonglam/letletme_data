import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createPlayerStatCache } from '../../src/domain/player-stat/cache';
import { toDomainPlayerStat } from '../../src/domain/player-stat/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import type { ElementResponse } from '../../src/types/element.type';
import type { PlayerStat } from '../../src/types/player-stat.type';
import { validatePlayerStatId } from '../../src/types/player-stat.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Stat Cache Tests', () => {
  let testPlayerStats: PlayerStat[];
  const TEST_PREFIX = CachePrefix.PLAYER_STAT;
  const TEST_SEASON = '2425';
  const TEST_EVENT_ID = 1;

  beforeAll(() => {
    // Convert bootstrap players to domain player stats with valid IDs
    testPlayerStats = bootstrapData.elements.slice(0, 3).map((player) => {
      const id = pipe(
        `${player.id}_${new Date().toISOString().slice(0, 10)}`,
        validatePlayerStatId,
        E.getOrElseW(() => {
          throw new Error('Failed to create valid player stat ID');
        }),
      );
      return {
        ...toDomainPlayerStat(player as ElementResponse, TEST_EVENT_ID),
        id,
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
    // Compare player stats by their unique identifiers
    const comparePlayerStat = (a: PlayerStat, b: PlayerStat): boolean => {
      return a.eventId === b.eventId && a.elementId === b.elementId;
    };

    // Compare arrays of player stats
    const comparePlayerStatArrays = (
      a: readonly PlayerStat[],
      b: readonly PlayerStat[],
    ): boolean => {
      if (a.length !== b.length) {
        console.log('Length mismatch:', a.length, b.length);
        return false;
      }

      // Sort both arrays by eventId and elementId for consistent comparison
      const sortedA = [...a].sort((x, y) => x.eventId - y.eventId || x.elementId - y.elementId);
      const sortedB = [...b].sort((x, y) => x.eventId - y.eventId || x.elementId - y.elementId);

      for (let i = 0; i < sortedA.length; i++) {
        if (!comparePlayerStat(sortedA[i], sortedB[i])) {
          console.log('Mismatch at index', i);
          console.log('Player Stat A:', JSON.stringify(sortedA[i], null, 2));
          console.log('Player Stat B:', JSON.stringify(sortedB[i], null, 2));
          return false;
        }
      }

      return true;
    };

    it('should set and get a single player stat', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const playerStatCache = createPlayerStatCache(
        redis,
        {
          getOneByEvent: async () => null,
          getAllByEvent: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
          eventId: TEST_EVENT_ID,
        },
      );

      const testPlayerStat = testPlayerStats[0];
      const cacheResult = await pipe(playerStatCache.cachePlayerStat(testPlayerStat))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(playerStatCache.getPlayerStat(testPlayerStat.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStat(getResult.right, testPlayerStat)).toBe(true);
      }
    });

    it('should set and get multiple player stats', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const playerStatCache = createPlayerStatCache(
        redis,
        {
          getOneByEvent: async () => null,
          getAllByEvent: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
          eventId: TEST_EVENT_ID,
        },
      );

      const cacheResult = await pipe(playerStatCache.cachePlayerStats(testPlayerStats))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        const cachedPlayerStats = getResult.right;
        expect(comparePlayerStatArrays(cachedPlayerStats, testPlayerStats)).toBe(true);
      }
    });

    it('should handle cache miss with data provider fallback', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const testPlayerStat = testPlayerStats[0];
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockImplementation(async (id: number, eventId: number) => {
          const playerStat = testPlayerStats.find(
            (e) => e.elementId === id && e.eventId === eventId,
          );
          return playerStat || null;
        }),
        getAllByEvent: jest.fn().mockImplementation(async () => testPlayerStats),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      // Test cache miss for single player stat
      const getResult = await pipe(playerStatCache.getPlayerStat(testPlayerStat.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStat(getResult.right, testPlayerStat)).toBe(true);
        expect(mockDataProvider.getOneByEvent).toHaveBeenCalled();
      }

      // Test cache miss for all player stats
      const getAllResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getAllResult)).toBe(true);
      if (E.isRight(getAllResult) && getAllResult.right) {
        const cachedPlayerStats = getAllResult.right;
        expect(comparePlayerStatArrays(cachedPlayerStats, testPlayerStats)).toBe(true);
        expect(mockDataProvider.getAllByEvent).toHaveBeenCalled();
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getAllByEvent: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      // Test error handling for single player stat
      const getResult = await pipe(playerStatCache.getPlayerStat('1'))();
      expect(E.isLeft(getResult)).toBe(true);

      // Test error handling for all player stats
      const getAllResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isLeft(getAllResult)).toBe(true);
    });

    it('should warm up cache with initial data', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockResolvedValue(null),
        getAllByEvent: jest.fn().mockResolvedValue(testPlayerStats),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      const warmUpResult = await pipe(playerStatCache.warmUp())();
      expect(E.isRight(warmUpResult)).toBe(true);

      const getResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStatArrays(getResult.right, testPlayerStats)).toBe(true);
      }
    });

    it('should handle empty player stat data gracefully', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const playerStatCache = createPlayerStatCache(
        redis,
        {
          getOneByEvent: async () => null,
          getAllByEvent: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
          eventId: TEST_EVENT_ID,
        },
      );

      const getResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle malformed player stat data', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const playerStatCache = createPlayerStatCache(
        redis,
        {
          getOneByEvent: async () => null,
          getAllByEvent: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
          eventId: TEST_EVENT_ID,
        },
      );

      // Store malformed data directly in Redis
      await redisClient.hset(
        `${TEST_PREFIX}::${TEST_SEASON}::${TEST_EVENT_ID}`,
        'invalid',
        JSON.stringify({ invalid: 'data' }),
      );

      const getResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle concurrent cache operations', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const playerStatCache = createPlayerStatCache(
        redis,
        {
          getOneByEvent: async () => null,
          getAllByEvent: async () => [],
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
          eventId: TEST_EVENT_ID,
        },
      );

      // Perform multiple cache operations concurrently
      const operations = testPlayerStats.map((stat) =>
        pipe(playerStatCache.cachePlayerStat(stat))(),
      );

      const results = await Promise.all(operations);
      expect(results.every(E.isRight)).toBe(true);

      const getResult = await pipe(playerStatCache.getAllPlayerStats())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(comparePlayerStatArrays(getResult.right, testPlayerStats)).toBe(true);
      }
    });

    it('should handle event-specific caching', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockImplementation(async (id: number, eventId: number) => {
          const playerStat = testPlayerStats.find(
            (e) => e.elementId === id && e.eventId === eventId,
          );
          return playerStat || null;
        }),
        getAllByEvent: jest
          .fn()
          .mockImplementation(async (eventId: number) =>
            testPlayerStats.filter((stat) => stat.eventId === eventId),
          ),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      // Cache player stats for specific event
      const testEventStats = testPlayerStats.map((stat) => ({ ...stat, eventId: TEST_EVENT_ID }));
      const cacheResult = await pipe(
        playerStatCache.cachePlayerStats(testEventStats, TEST_EVENT_ID),
      )();
      expect(E.isRight(cacheResult)).toBe(true);

      // Get player stats for the specific event
      const getResult = await pipe(playerStatCache.getAllPlayerStats(TEST_EVENT_ID))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStatArrays(getResult.right, testEventStats)).toBe(true);
      }

      // Verify different event returns empty and triggers data provider
      const differentEventId = TEST_EVENT_ID + 1;
      const differentEventResult = await pipe(
        playerStatCache.getAllPlayerStats(differentEventId),
      )();
      expect(E.isRight(differentEventResult)).toBe(true);
      expect(mockDataProvider.getAllByEvent).toHaveBeenCalledWith(differentEventId);
    });

    it('should handle event-specific player stat retrieval', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const testPlayerStat = { ...testPlayerStats[0], eventId: TEST_EVENT_ID };
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockImplementation(async (id: number, eventId: number) => {
          return testPlayerStat.elementId === id && testPlayerStat.eventId === eventId
            ? testPlayerStat
            : null;
        }),
        getAllByEvent: jest.fn().mockImplementation(async () => []),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      // Cache a player stat for specific event
      const cacheResult = await pipe(
        playerStatCache.cachePlayerStat(testPlayerStat, TEST_EVENT_ID),
      )();
      expect(E.isRight(cacheResult)).toBe(true);

      // Get the player stat for the specific event
      const getResult = await pipe(
        playerStatCache.getPlayerStat(testPlayerStat.elementId.toString(), TEST_EVENT_ID),
      )();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStat(getResult.right, testPlayerStat)).toBe(true);
      }

      // Verify different event triggers data provider
      const differentEventId = TEST_EVENT_ID + 1;
      const differentEventResult = await pipe(
        playerStatCache.getPlayerStat(testPlayerStat.elementId.toString(), differentEventId),
      )();
      expect(E.isRight(differentEventResult)).toBe(true);
      expect(mockDataProvider.getOneByEvent).toHaveBeenCalledWith(
        testPlayerStat.elementId,
        differentEventId,
      );
    });

    it('should warm up cache for specific event', async () => {
      const redis = createRedisCache<PlayerStat>({ keyPrefix: TEST_PREFIX });
      const testEventStats = testPlayerStats.map((stat) => ({ ...stat, eventId: TEST_EVENT_ID }));
      const mockDataProvider = {
        getOneByEvent: jest.fn().mockResolvedValue(null),
        getAllByEvent: jest
          .fn()
          .mockImplementation(async (eventId: number) =>
            eventId === TEST_EVENT_ID ? testEventStats : [],
          ),
      };

      const playerStatCache = createPlayerStatCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
        eventId: TEST_EVENT_ID,
      });

      const warmUpResult = await pipe(playerStatCache.warmUp(TEST_EVENT_ID))();
      expect(E.isRight(warmUpResult)).toBe(true);

      const getResult = await pipe(playerStatCache.getAllPlayerStats(TEST_EVENT_ID))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePlayerStatArrays(getResult.right, testEventStats)).toBe(true);
      }
      expect(mockDataProvider.getAllByEvent).toHaveBeenCalledWith(TEST_EVENT_ID);
    });
  });
});
