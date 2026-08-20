import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  assertRedisEndpointsSeparated,
  resolveCacheRedisConfig,
  resolveQueueRedisConfig,
  type AppConfig,
} from '../../src/utils/config';
import { resolveUnderstatPermitRedisConfig } from '../../src/utils/understat-rate-limit';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    CACHE_REDIS_HOST: 'cache.internal',
    CACHE_REDIS_PORT: 6379,
    CACHE_REDIS_DB: 0,
    QUEUE_REDIS_HOST: 'queue.internal',
    QUEUE_REDIS_PORT: 6379,
    QUEUE_REDIS_DB: 0,
    DATABASE_URL: 'postgresql://localhost/test',
    DATABASE_POOL_MAX: 5,
    PORT: 3000,
    WORKER_HEARTBEAT_INTERVAL_MS: 30_000,
    LOG_LEVEL: 'error',
    ENABLE_AUTH: false,
    RATE_LIMIT_MUTATIONS_PER_MINUTE: 60,
    DATA_SYNC_ATTEMPT_REPORTING_ENABLED: true,
    TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: false,
    FPL_MAX_INFLIGHT: 5,
    FPL_REQUESTS_PER_SECOND: 4,
    FPL_BULK_MAX_INFLIGHT_DURING_LIVE: 3,
    FPL_ADMISSION_LEASE_MS: 45_000,
    FPL_REQUEST_TIMEOUT_MS: 10_000,
    FPL_REQUEST_DEADLINE_MS: 40_000,
    FPL_RETRY_BASE_DELAY_MS: 500,
    FPL_RETRY_MAX_DELAY_MS: 5_000,
    ENTRY_SYNC_CHUNK_SIZE: 500,
    ENTRY_SYNC_CONCURRENCY: 5,
    ENTRY_SYNC_THROTTLE_MS: 200,
    TOURNAMENT_SETUP_STUCK_CUTOFF_MINUTES: 15,
    TOURNAMENT_SETUP_WATCHDOG_INTERVAL_MS: 300_000,
    TOURNAMENT_EVENT_LIVE_TIMEOUT_MS: 45_000,
    TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS: 45_000,
    TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS: 60_000,
    LIVE_POLL_MS: 30_000,
    PICKS_FIRST_PROBE_OFFSET_MS: 90 * 60_000,
    PICKS_RETRY_SCHEDULE_MS: '120000,180000,300000,600000',
    BETWEEN_FIXTURES_POLL_MS: 5 * 60_000,
    DAY_SETTLING_INITIAL_POLL_MS: 60_000,
    DAY_SETTLING_STABLE_POLL_MS: 5 * 60_000,
    DAY_SETTLING_STABLE_AFTER_MS: 10 * 60_000,
    PICKS_PROBE_POLL_MS: 120_000,
    PRE_DEADLINE_POLL_MS: 5 * 60_000,
    GW_REVIEW_POLL_MS: 10 * 60_000,
    GW_REVIEW_FINALIZATION_POLL_MS: 2 * 60_000,
    FINALIZED_POLL_MS: 5 * 60_000,
    UNDERSTAT_ENABLED: false,
    UNDERSTAT_BASE_URL: 'https://understat.com',
    UNDERSTAT_LEAGUE: 'EPL',
    UNDERSTAT_MIN_SEASON: '2526',
    UNDERSTAT_SEASON: '2627',
    UNDERSTAT_TIMEOUT_MS: 10_000,
    UNDERSTAT_MAX_CONCURRENCY: 4,
  };
  return Object.assign(base, overrides);
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
    expect(resolveUnderstatPermitRedisConfig(value)).toEqual({
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

  test('keeps disabled Understat queue clients lazy', () => {
    const teamQueue = readFileSync('src/queues/understat-team.queue.ts', 'utf8');
    const playerQueue = readFileSync('src/queues/understat-player.queue.ts', 'utf8');
    const worker = readFileSync('src/workers/understat.worker.ts', 'utf8');

    expect(teamQueue).not.toMatch(/export const understatTeamQueue\s*=\s*new Queue/);
    expect(playerQueue).not.toMatch(/export const understatPlayerQueue\s*=\s*new Queue/);
    expect(teamQueue).toContain('understatTeamQueue ??= new Queue');
    expect(playerQueue).toContain('understatPlayerQueue ??= new Queue');

    const disabledGuard = worker.indexOf('if (!getConfig().UNDERSTAT_ENABLED)');
    expect(disabledGuard).toBeGreaterThanOrEqual(0);
    expect(worker.indexOf('getUnderstatTeamQueue()', disabledGuard)).toBeGreaterThan(disabledGuard);
    expect(worker.indexOf('getUnderstatPlayerQueue()', disabledGuard)).toBeGreaterThan(
      disabledGuard,
    );
  });
});
