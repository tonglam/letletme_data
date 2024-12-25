import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPhaseCache, createPhaseOperations } from '../../../src/domains/phases/cache/cache';
import { createRedisClient } from '../../../src/infrastructure/cache/client/redis.client';
import { RedisClient, RedisConfig } from '../../../src/infrastructure/cache/types';
import { PrismaPhase } from '../../../src/types/phases.type';

describe('Phase Cache Integration', () => {
  jest.setTimeout(30000); // Increase timeout to 30 seconds

  const mockPhase: PrismaPhase = {
    id: 1,
    name: 'Test Phase',
    startEvent: 1,
    stopEvent: 38,
    highestScore: 100,
    createdAt: new Date('2024-12-22T08:50:24.525Z'),
  };

  const redisConfig: RedisConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableOfflineQueue: true,
    commandTimeout: 5000,
    reconnectStrategy: {
      maxAttempts: 5,
      delay: 2000,
    },
  };

  let redisClient: RedisClient;
  let phaseCache: ReturnType<typeof createPhaseOperations>;
  let mockDataProvider: {
    getAll: () => Promise<readonly PrismaPhase[]>;
    getOne: (id: string) => Promise<PrismaPhase | null>;
  };

  beforeAll(async () => {
    mockDataProvider = {
      getAll: jest.fn(async () => [mockPhase]),
      getOne: jest.fn(async (id: string) => (id === String(mockPhase.id) ? mockPhase : null)),
    };
  });

  afterAll(async () => {
    await pipe(
      redisClient.disconnect(),
      TE.fold(
        (error) => {
          console.error('Failed to disconnect from Redis:', error);
          return T.of(undefined);
        },
        () => T.of(undefined),
      ),
    )();
  });

  beforeEach(async () => {
    const clientOrError = await createRedisClient({
      ...redisConfig,
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      reconnectStrategy: {
        maxAttempts: 5,
        delay: 2000,
      },
    })();

    if ('left' in clientOrError) {
      throw new Error('Failed to create Redis client: ' + clientOrError.left.message);
    }
    redisClient = clientOrError.right;

    // Connect to Redis before each test
    const maxRetries = 5;
    let retries = 0;
    let connected = false;

    while (retries < maxRetries && !connected) {
      try {
        await pipe(
          redisClient.connect(),
          TE.fold(
            (error) => {
              console.error(`Failed to connect to Redis (attempt ${retries + 1}):`, error);
              return T.of(undefined);
            },
            () => {
              connected = true;
              return T.of(undefined);
            },
          ),
        )();

        // Wait for Redis to be ready with increased timeout
        let readyRetries = 0;
        while (readyRetries < 20 && !redisClient.isReady()) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          readyRetries++;
        }

        if (!redisClient.isReady()) {
          throw new Error('Redis client failed to be ready after retries');
        }

        connected = true;
      } catch (error) {
        retries++;
        if (retries === maxRetries) {
          throw new Error(`Failed to connect to Redis after ${maxRetries} attempts: ${error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    const cache = createPhaseCache(redisClient);
    phaseCache = createPhaseOperations(cache, mockDataProvider);

    // Clear all test keys before each test with increased retries
    await pipe(
      redisClient.keys('phase:*'),
      TE.chain((keys) => (keys.length > 0 ? redisClient.del(...keys) : TE.right(0))),
      TE.fold(
        (error) => {
          console.warn('Failed to clear test keys:', error);
          return T.of(undefined);
        },
        () => T.of(undefined),
      ),
    )();
  });

  const parsePhase = (phase: PrismaPhase | null): PrismaPhase | null => {
    if (!phase) return null;
    return {
      ...phase,
      createdAt: new Date(phase.createdAt),
    };
  };

  describe('Cache Operations', () => {
    test('should cache and retrieve phase', async () => {
      // First cache the phase
      await pipe(
        phaseCache.cachePhase(mockPhase),
        TE.fold(
          (error) => {
            throw error;
          },
          () => T.of(undefined),
        ),
      )();

      // Then retrieve it
      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          (error) => {
            throw error;
          },
          (phase) => T.of(parsePhase(phase)),
        ),
      )();

      expect(result).toEqual(mockPhase);
      expect(mockDataProvider.getOne).not.toHaveBeenCalled();
    });

    test('should handle non-existent phase', async () => {
      const result = await pipe(
        phaseCache.getPhase('999'),
        TE.fold(
          (error) => {
            throw error;
          },
          (phase) => T.of(parsePhase(phase)),
        ),
      )();

      expect(result).toBeNull();
      expect(mockDataProvider.getOne).toHaveBeenCalledWith('999');
    });

    test('should cache multiple phases', async () => {
      const phases = [mockPhase];

      await pipe(
        phaseCache.cacheBatch(phases),
        TE.fold(
          (error) => {
            throw error;
          },
          () => T.of(undefined),
        ),
      )();

      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          (error) => {
            throw error;
          },
          (phase) => T.of(parsePhase(phase)),
        ),
      )();

      expect(result).toEqual(mockPhase);
    });

    test('should fetch all phases and cache them', async () => {
      const result = await pipe(
        phaseCache.getAllPhases(),
        TE.fold(
          (error) => {
            throw error;
          },
          (phases) => T.of(phases.map((p) => parsePhase(p))),
        ),
      )();

      expect(result).toEqual([mockPhase]);
      expect(mockDataProvider.getAll).toHaveBeenCalled();

      // Verify phase was cached
      const cachedPhase = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          (error) => {
            throw error;
          },
          (phase) => T.of(parsePhase(phase)),
        ),
      )();

      expect(cachedPhase).toEqual(mockPhase);
    });

    test('should handle cache invalidation', async () => {
      // First cache the phase
      await pipe(
        phaseCache.cachePhase(mockPhase),
        TE.fold(
          (error) => {
            throw error;
          },
          () => T.of(undefined),
        ),
      )();

      // Then invalidate it
      await pipe(
        phaseCache.invalidateMany([String(mockPhase.id)]),
        TE.fold(
          (error) => {
            throw error;
          },
          () => T.of(undefined),
        ),
      )();

      // Verify it's no longer in cache
      const result = await pipe(
        phaseCache.getPhase(String(mockPhase.id)),
        TE.fold(
          (error) => {
            throw error;
          },
          (phase) => T.of(parsePhase(phase)),
        ),
      )();

      expect(result).toEqual(mockPhase);
      expect(mockDataProvider.getOne).toHaveBeenCalledWith(String(mockPhase.id));
    });
  });

  describe('Error Handling', () => {
    test('should handle Redis connection errors', async () => {
      // Create a new Redis client with no retries and no offline queue
      const errorClientOrError = await createRedisClient({
        ...redisConfig,
        host: 'invalid-host', // Use invalid host to force connection error
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        reconnectStrategy: {
          maxAttempts: 0,
          delay: 0,
        },
      })();

      if ('left' in errorClientOrError) {
        throw new Error('Failed to create Redis client: ' + errorClientOrError.left.message);
      }
      const errorClient = errorClientOrError.right;

      // Try to connect, which should fail
      await pipe(
        errorClient.connect(),
        TE.fold(
          (error) => {
            console.error('Failed to connect Redis:', error);
            return T.of(undefined);
          },
          () => T.of(undefined),
        ),
      )();

      // Wait for connection attempt to fail
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(errorClient.isReady()).toBe(false);

      // Try to get a value from Redis, which should fail
      const result = await errorClient.get('test')();
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.type).toBe('OPERATION_ERROR');
        expect(result.left.message).toContain('Failed to get value for key: test');
      }
    });

    test('should handle provider errors', async () => {
      // Create a new mock provider that always fails
      const errorProvider = {
        getAll: jest.fn().mockRejectedValue(new Error('Provider error')),
        getOne: jest.fn().mockRejectedValue(new Error('Provider error')),
      };

      // Create a new cache with the error provider
      const errorCache = createPhaseCache(redisClient);
      const errorPhaseCache = createPhaseOperations(errorCache, errorProvider);

      // Try to get all phases, which should fail
      const result = await errorPhaseCache.getAllPhases()();
      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.type).toBe('OPERATION_ERROR');
        expect(result.left.message).toBe('Failed to fetch phases data');
        expect(result.left.cause).toBeDefined();
      }
    });
  });
});
