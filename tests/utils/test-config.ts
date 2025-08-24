import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';

import { logError, logInfo } from '../../src/utils/logger';

// Test database configuration
export const testDbConfig = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5432'),
  database: process.env.TEST_DB_NAME || 'letletme_data_test',
  username: process.env.TEST_DB_USER || 'postgres',
  password: process.env.TEST_DB_PASSWORD || 'postgres',
};

// Test Redis configuration
export const testRedisConfig = {
  host: process.env.TEST_REDIS_HOST || 'localhost',
  port: parseInt(process.env.TEST_REDIS_PORT || '6379'),
  db: parseInt(process.env.TEST_REDIS_DB || '1'), // Use DB 1 for tests
};

// Create test database connection
export function createTestDb() {
  const connectionString = `postgres://${testDbConfig.username}:${testDbConfig.password}@${testDbConfig.host}:${testDbConfig.port}/${testDbConfig.database}`;

  const client = postgres(connectionString, {
    max: 1, // Limit connections for tests
    onnotice: () => {}, // Suppress notices in tests
  });

  return drizzle(client);
}

// Create test Redis connection
export function createTestRedis() {
  return new Redis({
    host: testRedisConfig.host,
    port: testRedisConfig.port,
    db: testRedisConfig.db,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

// Test utilities
export async function setupTestDb() {
  try {
    const db = createTestDb();
    logInfo('Test database connection established');
    return db;
  } catch (error) {
    logError('Failed to setup test database', error);
    throw error;
  }
}

export async function setupTestRedis() {
  try {
    const redis = createTestRedis();
    await redis.connect();
    await redis.flushdb(); // Clear test database
    logInfo('Test Redis connection established and cleared');
    return redis;
  } catch (error) {
    logError('Failed to setup test Redis', error);
    throw error;
  }
}

export async function cleanupTestDb(db: ReturnType<typeof createTestDb>) {
  try {
    // Clean up test data - in a real setup, you might want to use transactions
    // For now, we'll clean specific tables in dependency order
    await db.execute('TRUNCATE TABLE player_values, players, teams, events CASCADE');
    logInfo('Test database cleaned up');
  } catch (error) {
    logError('Failed to cleanup test database', error);
  }
}

export async function cleanupTestRedis(redis: Redis) {
  try {
    await redis.flushdb();
    await redis.disconnect();
    logInfo('Test Redis cleaned up');
  } catch (error) {
    logError('Failed to cleanup test Redis', error);
  }
}

// Mock environment variables for testing
export function setupTestEnv() {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
}

// Test timeouts
export const TEST_TIMEOUTS = {
  unit: 5000, // 5 seconds for unit tests
  integration: 30000, // 30 seconds for integration tests
  api: 10000, // 10 seconds for API tests
};
