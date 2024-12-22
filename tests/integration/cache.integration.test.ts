import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import * as IOE from 'fp-ts/IOEither';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createRedisClient } from '../../src/infrastructure/cache/client/redis.client';
import { createCache } from '../../src/infrastructure/cache/core/cache';
import {
  CacheError,
  CacheErrorType,
  RedisClient,
  RedisConfig,
} from '../../src/infrastructure/cache/types';

describe('Cache Integration Tests', () => {
  let redisClient: RedisClient;
  let cache: ReturnType<typeof createCache<string>>;

  beforeAll(async () => {
    // Use test-specific Redis configuration
    const testConfig: RedisConfig = {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: false, // Connect immediately
      enableOfflineQueue: true, // Enable offline queue
      commandTimeout: 5000,
      reconnectStrategy: {
        maxAttempts: 5,
        delay: 1000,
      },
    };

    const client = await pipe(
      createRedisClient(testConfig),
      IOE.mapLeft((error) => {
        console.error('Failed to create Redis client:', error);
        throw error;
      }),
      TE.fromIOEither,
    )();

    if (client._tag === 'Left') {
      throw new Error('Failed to create Redis client');
    }

    redisClient = client.right;
    cache = createCache<string>(redisClient, 'test');

    // Connect to Redis
    await pipe(
      redisClient.connect(),
      TE.mapLeft((error) => {
        console.error('Failed to connect to Redis:', error);
        throw error;
      }),
    )();

    // Wait for connection to be established
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 30000); // 30 seconds timeout for setup

  afterAll(async () => {
    if (redisClient) {
      await pipe(
        redisClient.disconnect(),
        TE.mapLeft((error) => {
          console.error('Failed to disconnect from Redis:', error);
          throw error;
        }),
      )();
    }
  }, 10000); // 10 seconds timeout for cleanup

  afterEach(async () => {
    // Clean up test keys
    await pipe(
      redisClient.keys('test:*'),
      TE.chain((keys) => (keys.length > 0 ? redisClient.del(...keys) : TE.right(0))),
      TE.mapLeft((error) => {
        console.error('Failed to clean up test keys:', error);
        throw error;
      }),
    )();
  }, 10000); // 10 seconds timeout for cleanup

  describe('Set and Get Operations', () => {
    test('should store and retrieve value', async () => {
      const key = 'integration-test-key';
      const value = 'integration-test-value';

      // Set value
      const setResult = await pipe(
        cache.set(key, value),
        TE.fold(
          (error) => {
            console.error('Failed to set value:', error);
            return T.of(false);
          },
          () => T.of(true),
        ),
      )();

      expect(setResult).toBe(true);

      // Get value
      const getResult = await pipe(
        cache.get(key),
        TE.fold(
          (error) => {
            console.error('Failed to get value:', error);
            return T.of(null);
          },
          (value) => T.of(value),
        ),
      )();

      expect(getResult).toBe(value);
    }, 10000);

    test('should handle TTL correctly', async () => {
      const key = 'ttl-test-key';
      const value = 'ttl-test-value';
      const ttl = 1; // 1 second TTL

      // Set value with TTL
      await pipe(
        cache.set(key, value, ttl),
        TE.fold(
          (error) => {
            console.error('Failed to set value with TTL:', error);
            return T.of(false);
          },
          () => T.of(true),
        ),
      )();

      // Verify value exists
      const beforeExpiry = await pipe(
        cache.get(key),
        TE.fold(
          (error) => {
            console.error('Failed to get value before expiry:', error);
            return T.of(null);
          },
          (value) => T.of(value),
        ),
      )();

      expect(beforeExpiry).toBe(value);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, (ttl + 1) * 1000));

      // Verify value is gone
      const afterExpiry = await pipe(
        cache.get(key),
        TE.fold(
          (error) => {
            console.error('Failed to get value after expiry:', error);
            return T.of(null);
          },
          (value) => T.of(value),
        ),
      )();

      expect(afterExpiry).toBeNull();
    }, 10000);
  });

  describe('Delete Operation', () => {
    test('should delete existing key', async () => {
      const key = 'delete-test-key';
      const value = 'delete-test-value';

      // Set value
      await pipe(
        cache.set(key, value),
        TE.fold(
          (error) => {
            console.error('Failed to set value:', error);
            return T.of(false);
          },
          () => T.of(true),
        ),
      )();

      // Delete value
      const deleteResult = await pipe(
        cache.del(key),
        TE.getOrElse(() => T.of(0)),
      )();

      expect(deleteResult).toBe(1);

      // Verify value is gone
      const getResult = await pipe(
        cache.get(key),
        TE.fold(
          (error) => {
            console.error('Failed to get value:', error);
            return T.of(null);
          },
          (value) => T.of(value),
        ),
      )();

      expect(getResult).toBeNull();
    }, 10000);

    test('should handle non-existent key', async () => {
      const key = 'non-existent-key';

      const deleteResult = await pipe(
        cache.del(key),
        TE.getOrElse(() => T.of(0)),
      )();

      expect(deleteResult).toBe(0);
    }, 10000);
  });

  describe('Error Handling', () => {
    test('should handle invalid JSON data', async () => {
      const key = 'invalid-json-key';

      // Manually set invalid JSON using Redis client
      await pipe(
        redisClient.set(`test:${key}`, 'invalid json'),
        TE.fold(
          (error) => {
            console.error('Failed to set invalid JSON:', error);
            return T.of(false);
          },
          () => T.of(true),
        ),
      )();

      const result = await pipe(
        cache.get(key),
        TE.fold(
          (error) => T.of(error),
          () => T.of({ type: CacheErrorType.OPERATION, message: 'Success' } as CacheError),
        ),
      )();

      expect(result).toHaveProperty('type', CacheErrorType.OPERATION);
      expect(result).toHaveProperty('message', 'Failed to parse cache value');
    }, 10000);
  });

  describe('Concurrent Operations', () => {
    test('should handle multiple concurrent operations', async () => {
      const operations = Array.from({ length: 10 }, (_, i) => ({
        key: `concurrent-key-${i}`,
        value: `concurrent-value-${i}`,
      }));

      // Concurrent sets
      await Promise.all(
        operations.map(({ key, value }) =>
          pipe(
            cache.set(key, value),
            TE.fold(
              (error) => {
                console.error('Failed to set value:', error);
                return T.of(false);
              },
              () => T.of(true),
            ),
          )(),
        ),
      );

      // Concurrent gets
      const results = await Promise.all(
        operations.map(({ key, value }) =>
          pipe(
            cache.get(key),
            TE.fold(
              (error) => {
                console.error('Failed to get value:', error);
                return T.of(null);
              },
              (result) => T.of(result),
            ),
          )(),
        ),
      );

      // Verify all values were stored and retrieved correctly
      results.forEach((result, i) => {
        expect(result).toBe(operations[i].value);
      });

      // Concurrent deletes
      const deleteResults = await Promise.all(
        operations.map(({ key }) =>
          pipe(
            cache.del(key),
            TE.getOrElse(() => T.of(0)),
          )(),
        ),
      );

      // Verify all deletes were successful
      deleteResults.forEach((result) => {
        expect(result).toBe(1);
      });
    }, 20000);
  });
});
