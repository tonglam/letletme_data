import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';

import { assertIntegrationEnv } from '../integration/helpers/env-guard';

/**
 * Direct connection helpers for integration tests.
 *
 * Connections derive from the SAME environment the app singletons use, and the
 * env-guard is re-asserted at creation time — never use separate TEST_*
 * overrides that could silently point at different infrastructure.
 */
export function createTestDb() {
  assertIntegrationEnv();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for integration tests');
  }

  const client = postgres(connectionString, {
    max: 1, // Limit connections for tests
    onnotice: () => {}, // Suppress notices in tests
  });

  return drizzle(client);
}

export function createTestRedis() {
  assertIntegrationEnv();

  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    lazyConnect: true,
  });
}

// Test timeouts
export const TEST_TIMEOUTS = {
  unit: 5000, // 5 seconds for unit tests
  integration: 30000, // 30 seconds for integration tests
  api: 10000, // 10 seconds for API tests
};
