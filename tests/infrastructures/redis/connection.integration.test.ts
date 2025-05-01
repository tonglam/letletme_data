import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Redis } from 'ioredis';

const testRedisClient = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0', 10),
});

// This test uses the actual Redis connection from .env
describe('Redis Connection - Integration Test', () => {
  beforeAll(async () => {
    // Wait for connection to be ready
    if (testRedisClient.status !== 'ready') {
      await new Promise<void>((resolve) => {
        testRedisClient.on('ready', () => {
          resolve();
        });
      });
    }
  });

  afterAll(async () => {
    // Close the Redis connection after tests
    await testRedisClient.quit();
  });

  it('should connect to Redis successfully', () => {
    expect(testRedisClient).toBeDefined();
    // Redis status can be either ready or connecting, both are valid
    expect(['ready', 'connecting']).toContain(testRedisClient.status);
  });

  it('should set and get a value from Redis', async () => {
    // Set a test key
    const testKey = 'test:integration:key';
    const testValue = 'test-value-' + Date.now();

    await testRedisClient.set(testKey, testValue);

    // Get the value back
    const retrievedValue = await testRedisClient.get(testKey);
    expect(retrievedValue).toBe(testValue);

    // Clean up
    await testRedisClient.del(testKey);
  });

  it('should handle key expiration in Redis', async () => {
    // Set a test key with a 1 second expiration
    const testKey = 'test:integration:expiring-key';
    const testValue = 'test-value-expiring';

    await testRedisClient.set(testKey, testValue, 'EX', 1);

    // Get the value immediately
    const immediateValue = await testRedisClient.get(testKey);
    expect(immediateValue).toBe(testValue);

    // Wait 1.5 seconds for expiration
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Get the value after expiration
    const expiredValue = await testRedisClient.get(testKey);
    expect(expiredValue).toBeNull();
  });

  it('should pipeline multiple commands', async () => {
    const testKeyBase = 'test:integration:pipeline';
    const pipeline = testRedisClient.pipeline();

    // Add multiple commands
    pipeline.set(`${testKeyBase}:1`, 'value1');
    pipeline.set(`${testKeyBase}:2`, 'value2');
    pipeline.get(`${testKeyBase}:1`);
    pipeline.get(`${testKeyBase}:2`);

    // Execute pipeline
    const results = await pipeline.exec();

    // Check results (pipeline.exec returns [err, result] pairs)
    expect(results?.[0][1]).toBe('OK');
    expect(results?.[1][1]).toBe('OK');
    expect(results?.[2][1]).toBe('value1');
    expect(results?.[3][1]).toBe('value2');

    // Clean up
    await testRedisClient.del(`${testKeyBase}:1`, `${testKeyBase}:2`);
  });
});
