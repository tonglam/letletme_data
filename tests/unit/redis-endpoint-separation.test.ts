import { describe, expect, test } from 'bun:test';

import {
  assertRedisEndpointsSeparated,
  resolveCacheRedisConfig,
  resolveQueueRedisConfig,
  type AppConfig,
} from '../../src/utils/config';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    CACHE_REDIS_HOST: 'cache.internal',
    CACHE_REDIS_PORT: 6379,
    CACHE_REDIS_DB: 0,
    QUEUE_REDIS_HOST: 'queue.internal',
    QUEUE_REDIS_PORT: 6379,
    QUEUE_REDIS_DB: 0,
    DATABASE_URL: 'postgresql://localhost/test',
    PORT: 3000,
    LOG_LEVEL: 'error',
    ENABLE_AUTH: false,
    RATE_LIMIT_MUTATIONS_PER_MINUTE: 60,
    ENABLE_TIERED_MUTATION_QUEUES: false,
    ENABLE_MUTATION_CONFLICT_GUARD: true,
    TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: false,
    TRANSFER_SYNC_MODE: 'all',
    MUTATION_LOCK_TTL_MS: 30_000,
    MUTATION_LOCK_WAIT_TIMEOUT_MS: 120_000,
    MUTATION_LOCK_RETRY_DELAY_MS: 250,
    MUTATION_LOCK_HEARTBEAT_MS: 10_000,
    ...overrides,
  };
}

describe('Redis endpoint separation', () => {
  test('resolves cache and queue credentials independently', () => {
    const value = config({
      CACHE_REDIS_PASSWORD: 'cache-secret',
      QUEUE_REDIS_PASSWORD: 'queue-secret',
    });

    expect(resolveCacheRedisConfig(value)).toEqual({
      host: 'cache.internal',
      port: 6379,
      password: 'cache-secret',
      db: 0,
    });
    expect(resolveQueueRedisConfig(value)).toEqual({
      host: 'queue.internal',
      port: 6379,
      password: 'queue-secret',
      db: 0,
    });
  });

  test('rejects an identical endpoint after host normalization', () => {
    expect(() =>
      assertRedisEndpointsSeparated(
        config({
          CACHE_REDIS_HOST: ' Redis.Internal ',
          CACHE_REDIS_DB: 4,
          QUEUE_REDIS_HOST: 'redis.internal',
          QUEUE_REDIS_DB: 4,
        }),
      ),
    ).toThrow('must resolve to different');
  });

  test('allows separate logical databases on one local Redis deployment', () => {
    expect(() =>
      assertRedisEndpointsSeparated(
        config({
          CACHE_REDIS_HOST: '127.0.0.1',
          CACHE_REDIS_DB: 9,
          QUEUE_REDIS_HOST: '127.0.0.1',
          QUEUE_REDIS_DB: 10,
        }),
      ),
    ).not.toThrow();
  });
});
