import * as E from 'fp-ts/Either';
import { Redis } from 'ioredis';
import {
  closeRedisClient,
  createRedisClient,
  TEST_OPTIONS,
} from '../../src/infrastructure/redis/client';

describe('Redis Connection Tests', () => {
  const TEST_PREFIX = 'test:redis:';
  let redisClient: Redis;

  beforeAll(async () => {
    const clientResult = await createRedisClient({
      ...TEST_OPTIONS,
      keyPrefix: '', // Disable keyPrefix for tests
    })();
    expect(E.isRight(clientResult)).toBe(true);
    if (E.isLeft(clientResult)) {
      throw new Error('Failed to create Redis client');
    }
    redisClient = clientResult.right;
  });

  beforeEach(async () => {
    // Clean up any existing test keys
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(...existingKeys);
    }
  });

  afterAll(async () => {
    const keys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
    await closeRedisClient();
  });

  it('should connect to Redis successfully', async () => {
    const ping = await redisClient.ping();
    expect(ping).toBe('PONG');
  });

  it('should perform basic Redis operations', async () => {
    const key = `${TEST_PREFIX}test-key`;
    const value = 'test-value';

    // Set value
    await redisClient.set(key, value);

    // Get value
    const result = await redisClient.get(key);
    expect(result).toBe(value);

    // Delete value
    await redisClient.del(key);
    const deletedResult = await redisClient.get(key);
    expect(deletedResult).toBeNull();
  });

  it('should handle multiple operations', async () => {
    const keys = [`${TEST_PREFIX}key1`, `${TEST_PREFIX}key2`, `${TEST_PREFIX}key3`];
    const value = 'test-value';

    // Set multiple values
    await Promise.all(keys.map((key) => redisClient.set(key, value)));

    // Get multiple values
    const results = await Promise.all(keys.map((key) => redisClient.get(key)));
    expect(results).toEqual([value, value, value]);

    // Delete multiple values
    await redisClient.del(...keys);
    const deletedResults = await Promise.all(keys.map((key) => redisClient.get(key)));
    expect(deletedResults).toEqual([null, null, null]);
  });

  it('should handle key patterns', async () => {
    const patternKeys = [`${TEST_PREFIX}pattern:1`, `${TEST_PREFIX}pattern:2`];
    const otherKey = `${TEST_PREFIX}other:3`;
    const value = 'test-value';

    // Set pattern keys
    await Promise.all(patternKeys.map((key) => redisClient.set(key, value)));

    // Set other key
    await redisClient.set(otherKey, value);

    // Verify all keys were set
    const allKeys = [...patternKeys, otherKey];
    const results = await Promise.all(allKeys.map((key) => redisClient.get(key)));
    expect(results.every((r) => r === value)).toBe(true);

    // Get keys by pattern
    const foundKeys = await redisClient.keys(`${TEST_PREFIX}pattern:*`);
    expect(foundKeys).toHaveLength(2);
    expect(new Set(foundKeys)).toEqual(new Set(patternKeys));

    // Cleanup is handled by beforeEach/afterAll
  });

  it('should handle errors gracefully', async () => {
    // Try to get a non-existent key
    const result = await redisClient.get('non-existent-key');
    expect(result).toBeNull();

    // Try to delete a non-existent key
    const delResult = await redisClient.del('non-existent-key');
    expect(delResult).toBe(0);

    // Test error handling with invalid list operation
    await expect(redisClient.lpop('non-existent-list')).resolves.toBeNull();

    // Test error handling with wrong value type
    const key = `${TEST_PREFIX}error-test`;
    await redisClient.set(key, 'string-value');
    await expect(redisClient.incr(key)).rejects.toThrow();
  });
});
