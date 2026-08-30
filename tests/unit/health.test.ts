import { describe, expect, test } from 'bun:test';

import { checkReadiness, mismatchSinceForPublication } from '../../src/api/health';

describe('data API readiness', () => {
  test('preserves an aged checkpoint mismatch across an API restart', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    const requestedAt = now - 180_000;

    expect(mismatchSinceForPublication(undefined, requestedAt, now)).toBe(requestedAt);
    expect(mismatchSinceForPublication(now - 10_000, requestedAt, now)).toBe(requestedAt);
    expect(mismatchSinceForPublication(undefined, undefined, now)).toBe(now);
  });

  test('hot-path readiness ignores PostgreSQL and queue Redis', async () => {
    await expect(
      checkReadiness({
        postgres: async () => true,
        cacheRedis: async () => true,
        queueRedis: async () => true,
        activeSeason: async () => true,
        screenshotRetentionConfigured: async () => true,
      }),
    ).resolves.toEqual({
      ready: true,
      dependencies: {
        postgres: true,
        cacheRedis: true,
        queueRedis: true,
        activeSeason: true,
        screenshotRetentionConfigured: true,
      },
    });
  });

  test('reports each failed dependency without throwing', async () => {
    await expect(
      checkReadiness({
        postgres: async () => {
          throw new Error('database unavailable');
        },
        cacheRedis: async () => false,
        queueRedis: async () => true,
        activeSeason: async () => false,
        screenshotRetentionConfigured: async () => true,
      }),
    ).resolves.toEqual({
      ready: false,
      dependencies: {
        postgres: false,
        cacheRedis: false,
        queueRedis: true,
        activeSeason: false,
        screenshotRetentionConfigured: true,
      },
    });
  });

  test('fails a dependency probe that exceeds the readiness deadline', async () => {
    const started = Date.now();
    const result = await checkReadiness({
      postgres: () => new Promise<boolean>(() => undefined),
      cacheRedis: async () => true,
      queueRedis: async () => true,
      activeSeason: async () => true,
      screenshotRetentionConfigured: async () => true,
      strict: true,
      probeTimeoutMs: 10,
    });

    expect(result.ready).toBe(false);
    expect(result.dependencies.postgres).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
