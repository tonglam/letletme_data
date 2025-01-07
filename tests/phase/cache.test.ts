import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createPhaseCache } from '../../src/domain/phase/cache';
import { toDomainPhase } from '../../src/domain/phase/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import type { Phase, PhaseResponse } from '../../src/types/phase.type';
import bootstrapData from '../data/bootstrap.json';

describe('Phase Cache Tests', () => {
  let testPhases: Phase[];
  const TEST_PREFIX = CachePrefix.PHASE;
  const TEST_SEASON = 2425;

  beforeAll(() => {
    // Convert bootstrap phases to domain phases
    testPhases = bootstrapData.phases.map((phase) => toDomainPhase(phase as PhaseResponse));
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
    const comparePhases = (a: Phase, b: Phase): boolean => {
      return JSON.stringify(a) === JSON.stringify(b);
    };

    const comparePhaseArrays = (a: readonly Phase[], b: readonly Phase[]): boolean => {
      if (a.length !== b.length) {
        console.log('Length mismatch:', a.length, b.length);
        return false;
      }

      // Sort both arrays by ID for consistent comparison
      const sortedA = [...a].sort((x, y) => Number(x.id) - Number(y.id));
      const sortedB = [...b].sort((x, y) => Number(x.id) - Number(y.id));

      for (let i = 0; i < sortedA.length; i++) {
        if (!comparePhases(sortedA[i], sortedB[i])) {
          console.log('Mismatch at index', i);
          console.log('Phase A:', JSON.stringify(sortedA[i], null, 2));
          console.log('Phase B:', JSON.stringify(sortedB[i], null, 2));
          return false;
        }
      }

      return true;
    };

    it('should set and get a single phase', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const phaseCache = createPhaseCache(
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

      const testPhase = testPhases[0];
      const cacheResult = await pipe(phaseCache.cachePhase(testPhase))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(phaseCache.getPhase(testPhase.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePhases(getResult.right, testPhase)).toBe(true);
      }
    });

    it('should set and get multiple phases', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const phaseCache = createPhaseCache(
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

      const cacheResult = await pipe(phaseCache.cachePhases(testPhases))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        const cachedPhases = getResult.right;
        expect(comparePhaseArrays(cachedPhases, testPhases)).toBe(true);
      }
    });

    it('should handle cache miss with data provider fallback', async () => {
      // Clear the cache before starting the test
      const cacheKey = `${TEST_PREFIX}::${TEST_SEASON}`;
      const keys = await redisClient.keys(`${cacheKey}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const testPhase = testPhases[0];
      const mockDataProvider = {
        getOne: jest.fn().mockImplementation(async (id: number) => {
          const phase = testPhases.find((e) => Number(e.id) === id);
          return phase || null;
        }),
        getAll: jest.fn().mockImplementation(async () => {
          // Return a copy of testPhases to avoid mutation
          return [...testPhases];
        }),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test cache miss for single phase
      const getResult = await pipe(phaseCache.getPhase(testPhase.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePhases(getResult.right, testPhase)).toBe(true);
        expect(mockDataProvider.getOne).toHaveBeenCalledWith(Number(testPhase.id));
      }

      // Clear the cache before testing getAllPhases
      const allKeys = await redisClient.keys(`${cacheKey}*`);
      if (allKeys.length > 0) {
        await redisClient.del(allKeys);
      }

      // Test cache miss for all phases
      const getAllResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getAllResult)).toBe(true);
      if (E.isRight(getAllResult) && getAllResult.right) {
        const cachedPhases = getAllResult.right;
        expect(cachedPhases.length).toBe(testPhases.length);
        expect(comparePhaseArrays(cachedPhases, testPhases)).toBe(true);
        expect(mockDataProvider.getAll).toHaveBeenCalled();

        // Verify that phases are properly cached
        const verifyResult = await pipe(phaseCache.getAllPhases())();
        expect(E.isRight(verifyResult)).toBe(true);
        if (E.isRight(verifyResult) && verifyResult.right) {
          expect(verifyResult.right.length).toBe(testPhases.length);
          expect(comparePhaseArrays(verifyResult.right, testPhases)).toBe(true);
          // getAll should not be called again
          expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
        }
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getAll: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test error handling for single phase
      const getResult = await pipe(phaseCache.getPhase('1'))();
      expect(E.isLeft(getResult)).toBe(true);

      // Test error handling for all phases
      const getAllResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isLeft(getAllResult)).toBe(true);
    });

    it('should warm up cache with initial data', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue(testPhases),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Warm up cache
      const warmUpResult = await pipe(phaseCache.warmUp())();
      expect(E.isRight(warmUpResult)).toBe(true);
      expect(mockDataProvider.getAll).toHaveBeenCalled();

      // Verify data is cached
      const getResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(comparePhaseArrays(getResult.right, testPhases)).toBe(true);
        // Should not call data provider again
        expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
      }
    });

    it('should handle different seasons and key prefixes', async () => {
      const customPrefix = CachePrefix.PHASE;
      const customSeason = 2024;
      const redis = createRedisCache<Phase>({ keyPrefix: customPrefix });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPhases[0]),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: customPrefix,
        season: customSeason,
      });

      // Cache multiple phases to test multi command
      const cacheResult = await pipe(phaseCache.cachePhases([testPhases[0], testPhases[1]]))();
      expect(E.isRight(cacheResult)).toBe(true);

      // Verify the phases are stored in Redis with correct key
      const key = `${customPrefix}::${customSeason}`;
      const values = await redisClient.hgetall(key);
      expect(values).toBeTruthy();
      expect(Object.keys(values).length).toBe(2);

      // Verify we can retrieve them through the cache
      const getResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(getResult.right.length).toBe(2);
        expect(comparePhaseArrays(getResult.right, [testPhases[0], testPhases[1]])).toBe(true);
      }
    });

    it('should handle empty phase data gracefully', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test caching empty array
      const cacheResult = await pipe(phaseCache.cachePhases([]))();
      expect(E.isRight(cacheResult)).toBe(true);

      // Test getting phases when cache is empty
      const getResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle malformed phase data', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const key = `${TEST_PREFIX}::${TEST_SEASON}`;

      // Manually insert malformed data
      await redisClient.hset(key, '999', 'invalid-json');

      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test getting all phases with malformed data
      const getResult = await pipe(phaseCache.getAllPhases())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        // Malformed data should be filtered out
        expect(getResult.right).toEqual([]);
      }
    });

    it('should handle concurrent cache operations', async () => {
      const redis = createRedisCache<Phase>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(testPhases[0]),
        getAll: jest.fn().mockResolvedValue(testPhases),
      };

      const phaseCache = createPhaseCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Perform multiple cache operations concurrently
      const [cacheResult, getAllResult] = await Promise.all([
        phaseCache.cachePhase(testPhases[0])(),
        phaseCache.getAllPhases()(),
      ]);

      // Verify each operation succeeded
      expect(E.isRight(cacheResult)).toBe(true);
      expect(E.isRight(getAllResult)).toBe(true);
    });
  });
});
