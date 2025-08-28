import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';

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
    lazyConnect: true,
  });
}

// Test timeouts
export const TEST_TIMEOUTS = {
  unit: 5000, // 5 seconds for unit tests
  integration: 30000, // 30 seconds for integration tests
  api: 10000, // 10 seconds for API tests
};
