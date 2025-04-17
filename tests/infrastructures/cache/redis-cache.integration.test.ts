// Load environment variables first
import 'dotenv/config';

import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CacheError, CacheErrorCode, createCacheError } from '../../../src/types/error.type';

// Helper function to convert TaskEither<CacheError, T | null> to TaskEither<CacheError, Option<T>>
const toOption = <T>(
  te: TE.TaskEither<CacheError, T | null>,
): TE.TaskEither<CacheError, O.Option<T>> =>
  pipe(
    te,
    TE.map((value) => (value === null ? O.none : O.some(value))),
  );

// Create direct Redis client for testing
const testRedisClient = new Redis({
  host: '118.194.234.17',
  port: 6379,
  password: 'letletguanlaoshiRedis1414',
  db: 0,
});

// Create custom Redis cache for testing
const createTestRedisCache = <T>() => {
  const keyPrefix = 'test:redis:';
  const makeKey = (key: string) => `${keyPrefix}${key}`;

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
      pipe(
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
        // Convert to Option
        TE.map((value) => (value === null ? null : value)),
      ),
    hSet: (key: string, field: string, value: T) =>
      TE.tryCatch(
        async () => {
          const serialized = JSON.stringify(value);
          await testRedisClient.hset(makeKey(key), field, serialized);
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to set hash field: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    hGet: (key: string, field: string) =>
      pipe(
        TE.tryCatch(
          async () => {
            const value = await testRedisClient.hget(makeKey(key), field);
            if (value === null) return null;
            return JSON.parse(value) as T;
          },
          (error) =>
            createCacheError({
              code: CacheErrorCode.OPERATION_ERROR,
              message: `Failed to get hash field: ${error}`,
              cause: error instanceof Error ? error : undefined,
            }),
        ),
        // Convert to Option
        TE.map((value) => (value === null ? null : value)),
      ),
    hGetAll: (key: string) =>
      TE.tryCatch(
        async () => {
          const values = await testRedisClient.hgetall(makeKey(key));
          if (!values || Object.keys(values).length === 0) return {};

          const result: Record<string, T> = {};
          for (const [field, value] of Object.entries(values)) {
            result[field] = JSON.parse(value as string) as T;
          }
          return result;
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to get all hash fields: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    del: (key: string) =>
      TE.tryCatch(
        async () => {
          await testRedisClient.del(makeKey(key));
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Failed to delete key: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
  };
};

describe('Redis Cache - Integration Test', () => {
  // Test key prefixes to avoid conflicts with other data
  const TEST_PREFIX = 'test:redis:';
  const TEST_KEY = 'testKey';
  const FULL_TEST_KEY = `${TEST_PREFIX}${TEST_KEY}`;

  // Test data
  const stringValue = 'test-string-value';
  const numberValue = 123;
  const objectValue = { id: 1, name: 'test' };
  const arrayValue = [1, 2, 3, 'test'];

  beforeAll(async () => {
    // Redis client auto-connects when created
    console.log('Connecting to Redis at:', testRedisClient.options.host);
  });

  afterAll(async () => {
    // Clean up test keys
    await testRedisClient.del(FULL_TEST_KEY);
    await testRedisClient.del(`${TEST_PREFIX}hash`);
    await testRedisClient.del(`${TEST_PREFIX}expire`);

    // Close Redis connection
    await testRedisClient.quit();
  });

  describe('Basic key-value operations', () => {
    it('should set and get a string value', async () => {
      const cache = createTestRedisCache<string>();

      await pipe(
        cache.set(TEST_KEY, stringValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      const result = await pipe(
        cache.get(TEST_KEY),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => '')(result)).toBe(stringValue);
    });

    it('should set and get a number value', async () => {
      const cache = createTestRedisCache<number>();

      await pipe(
        cache.set(TEST_KEY, numberValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      const result = await pipe(
        cache.get(TEST_KEY),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => 0)(result)).toBe(numberValue);
    });

    it('should set and get an object value', async () => {
      const cache = createTestRedisCache<typeof objectValue>();

      await pipe(
        cache.set(TEST_KEY, objectValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      const result = await pipe(
        cache.get(TEST_KEY),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => ({ id: 0, name: '' }))(result)).toEqual(objectValue);
    });

    it('should set and get an array value', async () => {
      const cache = createTestRedisCache<typeof arrayValue>();

      await pipe(
        cache.set(TEST_KEY, arrayValue),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      const result = await pipe(
        cache.get(TEST_KEY),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(result)).toBe(true);
      expect(O.getOrElse(() => [])(result)).toEqual(arrayValue);
    });

    it('should return None for non-existent key', async () => {
      const cache = createTestRedisCache<string>();
      const nonExistentKey = 'non-existent-key';

      const result = await pipe(
        cache.get(nonExistentKey),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isNone(result)).toBe(true);
    });

    it('should delete a key', async () => {
      const cache = createTestRedisCache<string>();
      const deleteKey = 'delete-key';

      // First set a value
      await pipe(
        cache.set(deleteKey, 'to-be-deleted'),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Then delete it
      await pipe(
        cache.del(deleteKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to delete from cache: ${error.message}`);
        }),
      )();

      // Check it's gone
      const result = await pipe(
        cache.get(deleteKey),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isNone(result)).toBe(true);
    });
  });

  describe('Hash operations', () => {
    it('should set and get hash fields', async () => {
      const cache = createTestRedisCache<string>();
      const hashKey = 'hash';
      const field1 = 'field1';
      const value1 = 'value1';
      const field2 = 'field2';
      const value2 = 'value2';

      // Set hash fields
      await pipe(
        cache.hSet(hashKey, field1, value1),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set hash field: ${error.message}`);
        }),
      )();

      await pipe(
        cache.hSet(hashKey, field2, value2),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set hash field: ${error.message}`);
        }),
      )();

      // Get individual fields
      const field1Result = await pipe(
        cache.hGet(hashKey, field1),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get hash field: ${error.message}`);
        }),
      )();

      const field2Result = await pipe(
        cache.hGet(hashKey, field2),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get hash field: ${error.message}`);
        }),
      )();

      expect(O.isSome(field1Result)).toBe(true);
      expect(O.getOrElse(() => '')(field1Result)).toBe(value1);

      expect(O.isSome(field2Result)).toBe(true);
      expect(O.getOrElse(() => '')(field2Result)).toBe(value2);

      // Get all hash fields
      const allFields = await pipe(
        cache.hGetAll(hashKey),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get all hash fields: ${error.message}`);
        }),
      )();

      expect(allFields).toEqual({
        [field1]: value1,
        [field2]: value2,
      });
    });

    it('should handle non-existent hash and fields', async () => {
      const cache = createTestRedisCache<string>();
      const nonExistentHash = 'non-existent-hash';
      const nonExistentField = 'non-existent-field';

      const result = await pipe(
        cache.hGet(nonExistentHash, nonExistentField),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get hash field: ${error.message}`);
        }),
      )();

      expect(O.isNone(result)).toBe(true);

      const allFields = await pipe(
        cache.hGetAll(nonExistentHash),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get all hash fields: ${error.message}`);
        }),
      )();

      expect(allFields).toEqual({});
    });
  });

  describe('TTL operations', () => {
    it('should respect TTL (time-to-live)', async () => {
      const cache = createTestRedisCache<string>();
      const expiringKey = 'expire';
      const expiringValue = 'will-expire-soon';

      // Set with 1 second TTL
      await pipe(
        cache.set(expiringKey, expiringValue, 1),
        TE.getOrElse((error) => {
          throw new Error(`Failed to set cache value: ${error.message}`);
        }),
      )();

      // Check immediately - should exist
      const immediateResult = await pipe(
        cache.get(expiringKey),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isSome(immediateResult)).toBe(true);
      expect(O.getOrElse(() => '')(immediateResult)).toBe(expiringValue);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Check after TTL - should be gone
      const afterExpiryResult = await pipe(
        cache.get(expiringKey),
        // Convert to Option
        TE.map((value) => (value === null ? O.none : O.some(value))),
        TE.getOrElse((error) => {
          throw new Error(`Failed to get from cache: ${error.message}`);
        }),
      )();

      expect(O.isNone(afterExpiryResult)).toBe(true);
    });
  });
});
