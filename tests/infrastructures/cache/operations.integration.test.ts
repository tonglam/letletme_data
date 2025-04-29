// Load environment variables first
import 'dotenv/config';

import { afterAll, describe, expect, it } from 'bun:test';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { RedisCache } from 'infrastructure/cache/redis-cache';
import Redis from 'ioredis';

import { CacheError, CacheErrorCode, createCacheError } from '../../../src/types/error.type';

// Create our own Redis client for testing using environment variables
const testRedisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0', 10),
});

// Helper function to convert TaskEither<CacheError, T | null> to TaskEither<CacheError, Option<T>>
const toOption = <T>(
  te: TE.TaskEither<CacheError, T | null>,
): TE.TaskEither<CacheError, O.Option<T>> =>
  pipe(
    te,
    TE.map((value) => (value === null ? O.none : O.some(value))),
  );

// Create mock versions of Redis operations that use our test client
const mockRedisCache = <T>(): RedisCache<T> => {
  const makeKey = (key: string) => `test:operations:${key}`;

  return {
    client: testRedisClient,
    set: (key: string, value: T, ttl?: number) =>
      TE.tryCatch(
        async () => {
          const serialized = JSON.stringify(value);
          if (ttl) {
            await testRedisClient.setex(makeKey(key), ttl, serialized);
          } else {
            await testRedisClient.set(makeKey(key), serialized);
          }
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to set cache value: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    get: (key: string) =>
      TE.tryCatch(
        async () => {
          const value = await testRedisClient.get(makeKey(key));
          if (value === null) return null;
          return JSON.parse(value) as T;
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to get cache value: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    hSet: () => TE.right(undefined),
    hGet: () => TE.right(null),
    hGetAll: () => TE.right({}),
  };
};

// Define our own cache operations for the test
const createCacheOperations = <T>(cache: RedisCache<T>) => {
  return {
    cacheGet: (key: string): TE.TaskEither<CacheError, O.Option<T>> => toOption(cache.get(key)),

    cacheSet: (key: string, value: T, ttl?: number): TE.TaskEither<CacheError, void> =>
      cache.set(key, value, ttl),

    cacheClear: (key: string): TE.TaskEither<CacheError, void> =>
      TE.tryCatch(
        async () => {
          await cache.client.del(`test:operations:${key}`);
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to clear cache key: ${key}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
  };
};

// This test uses the actual Redis connection from .env
describe('Cache Operations - Integration Test', () => {
  // Test key prefixes to avoid conflicts with other data
  const TEST_PREFIX = 'test:operations:';

  afterAll(async () => {
    // Clean up test keys
    await testRedisClient.del(`${TEST_PREFIX}string-key`);
    await testRedisClient.del(`${TEST_PREFIX}number-key`);
    await testRedisClient.del(`${TEST_PREFIX}object-key`);
    await testRedisClient.del(`${TEST_PREFIX}expiring-key`);
    await testRedisClient.del(`${TEST_PREFIX}clear-key`);

    // Close Redis connection
    await testRedisClient.quit();
  });

  describe('cacheGet operation', () => {
    it('should return None when key does not exist', async () => {
      // Arrange
      const cache = mockRedisCache<string>();
      const { cacheGet } = createCacheOperations(cache);
      const nonExistentKey = 'non-existent-key';

      // Act
      const result = await pipe(
        cacheGet(nonExistentKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      // Assert
      expect(O.isNone(result)).toBe(true);
    });

    it('should return Some(value) when key exists with string value', async () => {
      // Arrange
      const cache = mockRedisCache<string>();
      const { cacheSet, cacheGet } = createCacheOperations(cache);
      const testKey = 'string-key';
      const testValue = 'string-value';

      // First set a value
      await pipe(
        cacheSet(testKey, testValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Act - Get the value
      const result: O.Option<string> = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      // Assert
      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => '')(result)).toBe(testValue);
    });

    it('should return Some(value) when key exists with number value', async () => {
      // Arrange
      const cache = mockRedisCache<number>();
      const { cacheSet, cacheGet } = createCacheOperations(cache);
      const testKey = 'number-key';
      const testValue = 12345;

      // First set a value
      await pipe(
        cacheSet(testKey, testValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Act - Get the value
      const result: O.Option<number> = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      // Assert
      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => 0)(result)).toBe(testValue);
    });

    it('should return Some(value) when key exists with object value', async () => {
      // Arrange
      type TestObject = { id: number; name: string; timestamp: Date };
      const cache = mockRedisCache<TestObject>();
      const { cacheSet, cacheGet } = createCacheOperations(cache);
      const testKey = 'object-key';
      const now = new Date();
      const testValue: TestObject = { id: 1, name: 'test-object', timestamp: now };

      // First set a value
      await pipe(
        cacheSet(testKey, testValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Act - Get the value
      const result: O.Option<TestObject> = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      // Assert
      expect(O.isSome(result)).toBe(true);

      const retrievedValue = O.getOrElse(() => ({ id: 0, name: '', timestamp: new Date(0) }))(
        result,
      );

      expect(retrievedValue.id).toBe(testValue.id);
      expect(retrievedValue.name).toBe(testValue.name);
      // Date is serialized as a string in JSON
      expect(typeof retrievedValue.timestamp).toBe('string');
    });
  });

  describe('cacheSet operation', () => {
    it('should set a value with expiry time', async () => {
      // Arrange
      const cache = mockRedisCache<string>();
      const { cacheSet, cacheGet } = createCacheOperations(cache);
      const testKey = 'expiring-key';
      const testValue = 'expiring-value';

      // Act - Set with 1 second TTL
      await pipe(
        cacheSet(testKey, testValue, 1), // 1 second TTL
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Assert - First check value exists
      const immediateResult: O.Option<string> = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(immediateResult)).toBe(true);
      expect(O.getOrElse(() => '')(immediateResult)).toBe(testValue);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Assert - Check value has expired
      const afterExpiryResult = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isNone(afterExpiryResult)).toBe(true);
    });
  });

  describe('cacheClear operation', () => {
    it('should clear a specific key from the cache', async () => {
      // Arrange
      const cache = mockRedisCache<string>();
      const { cacheSet, cacheGet, cacheClear } = createCacheOperations(cache);
      const testKey = 'clear-key';
      const testValue = 'to-be-cleared';

      // First set a value
      await pipe(
        cacheSet(testKey, testValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Verify it was set
      const beforeClearResult = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(beforeClearResult)).toBe(true);

      // Act - Clear the value
      await pipe(
        cacheClear(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to clear cache: ${error.message}`);
        }),
      )();

      // Assert - Value should be gone
      const afterClearResult = await pipe(
        cacheGet(testKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isNone(afterClearResult)).toBe(true);
    });
  });
});
