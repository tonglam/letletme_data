import { describe, expect, test } from 'bun:test';

import { connectQueueRedisWithTimeout, pingQueueRedisWithTimeout } from '../../src/queues/redis';

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

  test('disconnects a queue Redis connection attempt that exceeds its deadline', async () => {
    let disconnected = false;
    await expect(
      connectQueueRedisWithTimeout(
        {
          connect: () => new Promise<void>(() => undefined),
          disconnect: () => {
            disconnected = true;
          },
        } as never,
        10,
      ),
    ).rejects.toThrow('Queue Redis connection timed out after 10ms');
    expect(disconnected).toBe(true);
  });
});
