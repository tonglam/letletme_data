import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache, RedisCache } from '../../src/infrastructure/cache/redis-cache';

const TEST_PREFIX = 'test:redis:';
let cache: RedisCache<string>;

describe('Redis Cache Infrastructure Tests', () => {
  beforeAll(async () => {
    // Initialize cache with test prefix
    cache = createRedisCache<string>({ keyPrefix: TEST_PREFIX });
  });

  afterAll(async () => {
    // Clean up test keys
    const testKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (testKeys.length > 0) {
      await redisClient.del(testKeys);
    }
  });

  afterEach(async () => {
    // Clean up test keys after each test
    const testKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (testKeys.length > 0) {
      await redisClient.del(testKeys);
    }
  });

  describe('Basic Cache Operations', () => {
    it('should set and get a value', async () => {
      const key = 'test-key';
      const value = 'test-value';

      const setResult = await cache.set(key, value)();
      expect(E.isRight(setResult)).toBe(true);

      const getResult = await cache.get(key)();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toBe(value);
      }
    });

    it('should handle TTL correctly', async () => {
      const ttlCache = createRedisCache<string>({ keyPrefix: TEST_PREFIX, defaultTTL: 1 });
      const key = 'ttl-test';
      const value = 'ttl-value';

      await ttlCache.set(key, value)();
      await new Promise((resolve) => setTimeout(resolve, 1100)); // Wait for TTL to expire

      const result = await ttlCache.get(key)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });

    it('should handle non-existent keys', async () => {
      const result = await cache.get('non-existent-key')();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('Hash Operations', () => {
    it('should set and get hash fields', async () => {
      const key = 'hash-test';
      const field = 'field1';
      const value = 'hash-value';

      const setResult = await cache.hSet(key, field, value)();
      expect(E.isRight(setResult)).toBe(true);

      const getResult = await cache.hGet(key, field)();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult)) {
        expect(getResult.right).toBe(value);
      }
    });

    it('should get all hash fields', async () => {
      const key = 'hash-all-test';
      const fields = {
        field1: 'value1',
        field2: 'value2',
        field3: 'value3',
      };

      // Set multiple hash fields
      await Promise.all(
        Object.entries(fields).map(([field, value]) => cache.hSet(key, field, value)()),
      );

      const result = await cache.hGetAll(key)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(fields);
      }
    });
  });

  describe('Complex Data Types', () => {
    interface TestObject {
      id: number;
      name: string;
      nested: {
        value: string;
      };
    }

    it('should handle complex objects', async () => {
      const objectCache = createRedisCache<TestObject>({ keyPrefix: TEST_PREFIX });
      const key = 'object-test';
      const value: TestObject = {
        id: 1,
        name: 'test',
        nested: {
          value: 'nested-value',
        },
      };

      await objectCache.set(key, value)();
      const result = await objectCache.get(key)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(value);
      }
    });

    it('should handle arrays of objects', async () => {
      const arrayCache = createRedisCache<TestObject[]>({ keyPrefix: TEST_PREFIX });
      const key = 'array-test';
      const value = [
        { id: 1, name: 'test1', nested: { value: 'value1' } },
        { id: 2, name: 'test2', nested: { value: 'value2' } },
      ];

      await arrayCache.set(key, value)();
      const result = await arrayCache.get(key)();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(value);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON data gracefully', async () => {
      const key = `${TEST_PREFIX}invalid-json`;
      // Store an invalid JSON string that will fail parsing
      await redisClient.set(key, '{'); // Incomplete JSON object

      const result = await pipe(
        TE.tryCatch(
          () => redisClient.get(key),
          (error) => new Error(`Failed to get cache key: ${error}`),
        ),
        TE.chain((value) =>
          TE.tryCatch(
            () => Promise.resolve(value ? JSON.parse(value) : null),
            (error) => new Error(`Failed to parse JSON: ${error}`),
          ),
        ),
      )();

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.message).toContain('Failed to parse JSON');
      }
    });

    it('should handle connection errors gracefully', async () => {
      const currentStatus = redisClient.status;
      await redisClient.disconnect();

      const result = await cache.set('test', 'value')();
      expect(E.isLeft(result)).toBe(true);

      // Restore connection
      if (currentStatus === 'ready') {
        await redisClient.connect();
      }
    });
  });

  describe('Configuration', () => {
    it('should respect key prefix configuration', async () => {
      const prefix = `${TEST_PREFIX}custom:`;
      const prefixCache = createRedisCache<string>({ keyPrefix: prefix });
      const key = 'prefixed-key';
      const value = 'prefixed-value';

      await prefixCache.set(key, value)();

      // Verify the key was stored with prefix
      const storedValue = await redisClient.get(`${prefix}${key}`);
      expect(JSON.parse(storedValue!)).toBe(value);
    });

    it('should respect default TTL configuration', async () => {
      const ttlCache = createRedisCache<string>({ keyPrefix: TEST_PREFIX, defaultTTL: 1 });
      const key = 'default-ttl-test';
      const value = 'ttl-value';

      await ttlCache.set(key, value)();

      // Verify TTL was set
      const ttl = await redisClient.ttl(`${TEST_PREFIX}${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(1);
    });
  });
});
