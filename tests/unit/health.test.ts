import { describe, expect, test } from 'bun:test';

import { checkReadiness } from '../../src/api/health';

describe('data API readiness', () => {
  test('is ready only when PostgreSQL, Redis, and active season respond', async () => {
    await expect(
      checkReadiness({
        postgres: async () => true,
        redis: async () => true,
        activeSeason: async () => true,
      }),
    ).resolves.toEqual({
      ready: true,
      dependencies: { postgres: true, redis: true, activeSeason: true },
    });
  });

  test('reports each failed dependency without throwing', async () => {
    await expect(
      checkReadiness({
        postgres: async () => {
          throw new Error('database unavailable');
        },
        redis: async () => false,
        activeSeason: async () => false,
      }),
    ).resolves.toEqual({
      ready: false,
      dependencies: { postgres: false, redis: false, activeSeason: false },
    });
  });
});
