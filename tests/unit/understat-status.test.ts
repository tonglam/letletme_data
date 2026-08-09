import { describe, expect, test } from 'bun:test';

import { readManifest } from '../../src/services/understat-status.service';

describe('Understat status manifest reads', () => {
  test('keeps durable status available when Redis manifest reads fail', async () => {
    await expect(
      readManifest('2526', 'team', async () => {
        throw new Error('Redis unavailable');
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'redis_unavailable' });
  });
});
