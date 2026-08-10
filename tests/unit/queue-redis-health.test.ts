import { describe, expect, test } from 'bun:test';

import { pingQueueRedisWithTimeout } from '../../src/queues/redis';

describe('queue Redis readiness ping', () => {
  test('accepts a prompt PONG response', async () => {
    await expect(
      pingQueueRedisWithTimeout({ ping: async () => 'PONG' } as never, 20),
    ).resolves.toBe(true);
  });

  test('rejects a queue Redis command that never settles', async () => {
    const startedAt = Date.now();
    await expect(
      pingQueueRedisWithTimeout({ ping: () => new Promise<string>(() => undefined) } as never, 10),
    ).rejects.toThrow('Queue Redis health ping timed out after 10ms');
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
