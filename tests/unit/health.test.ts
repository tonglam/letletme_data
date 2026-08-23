import { describe, expect, test } from 'bun:test';

import { checkReadiness } from '../../src/api/health';

describe('data API readiness', () => {
  test('is ready only when PostgreSQL, both Redis roles, and active season respond', async () => {
    await expect(
      checkReadiness({
        postgres: async () => true,
        cacheRedis: async () => true,
        queueRedis: async () => true,
        managerLiveQueue: async () => true,
        activeSeason: async () => true,
        screenshotRetentionConfigured: async () => true,
      }),
    ).resolves.toEqual({
      ready: true,
      dependencies: {
        postgres: true,
        cacheRedis: true,
        queueRedis: true,
        managerLiveQueue: true,
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
        managerLiveQueue: async () => false,
        activeSeason: async () => false,
        screenshotRetentionConfigured: async () => true,
      }),
    ).resolves.toEqual({
      ready: false,
      dependencies: {
        postgres: false,
        cacheRedis: false,
        queueRedis: true,
        managerLiveQueue: false,
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
      managerLiveQueue: async () => true,
      activeSeason: async () => true,
      screenshotRetentionConfigured: async () => true,
      probeTimeoutMs: 10,
    });

    expect(result.ready).toBe(false);
    expect(result.dependencies.postgres).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
