import { describe, expect, test } from 'bun:test';

import {
  checkReadiness,
  isMediaWorkerRequired,
  mismatchSinceForPublication,
  publicationMismatchGraceMs,
} from '../../src/api/health';
import { LIVE_SCORE_CHECKPOINT_INTERVAL_MS } from '../../src/domain/job-schedules';

describe('data API readiness', () => {
  test('preserves an aged checkpoint mismatch across an API restart', () => {
    const now = Date.parse('2026-08-30T12:00:00.000Z');
    const requestedAt = now - 180_000;

    expect(mismatchSinceForPublication(undefined, requestedAt, now)).toBe(requestedAt);
    expect(mismatchSinceForPublication(now - 10_000, requestedAt, now)).toBe(requestedAt);
    expect(mismatchSinceForPublication(undefined, undefined, now)).toBe(now);
  });

  test('allows one score checkpoint interval only for mutable Live Points', () => {
    expect(publicationMismatchGraceMs('fpl:core:2627:')).toBe(120_000);
    expect(publicationMismatchGraceMs('fpl:market:2627:')).toBe(120_000);
    expect(publicationMismatchGraceMs('live-points-v2:2627:3')).toBe(
      LIVE_SCORE_CHECKPOINT_INTERVAL_MS + 120_000,
    );
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

  test('allows strict readiness while the separately rolled out media worker is absent', async () => {
    const previous = process.env.RUNTIME_INCLUDE_MEDIA_WORKER;
    const previousRequired = process.env.RUNTIME_MEDIA_WORKER_REQUIRED;
    process.env.RUNTIME_INCLUDE_MEDIA_WORKER = 'false';
    delete process.env.RUNTIME_MEDIA_WORKER_REQUIRED;
    try {
      expect(isMediaWorkerRequired()).toBe(false);
      const result = await checkReadiness({
        postgres: async () => true,
        cacheRedis: async () => true,
        queueRedis: async () => true,
        activeSeason: async () => true,
        screenshotRetentionConfigured: async () => true,
        scheduler: async () => true,
        queueWorker: async () => true,
        contentWorker: async () => true,
        mediaWorker: async () => false,
        livePicksWorker: async () => true,
        officialH2HWorker: async () => true,
        publicationConsistency: async () => true,
        includeRuntimeDependencies: true,
        strict: true,
      });
      expect(result.ready).toBe(true);
      expect(result.dependencies.mediaWorker).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_INCLUDE_MEDIA_WORKER;
      else process.env.RUNTIME_INCLUDE_MEDIA_WORKER = previous;
      if (previousRequired === undefined) delete process.env.RUNTIME_MEDIA_WORKER_REQUIRED;
      else process.env.RUNTIME_MEDIA_WORKER_REQUIRED = previousRequired;
    }
  });
});
