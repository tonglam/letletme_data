import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { queueRedisSingleton } from '../../src/queues/redis';

const CACHE_PROBE = 'llm:data:test:cache-client-probe';
const QUEUE_PROBE = 'llm:queue:coordination:test:queue-client-probe';

afterAll(async () => {
  const cache = await redisSingleton.getClient();
  const queue = await queueRedisSingleton.getClient();
  await cache.unlink(CACHE_PROBE);
  await queue.unlink(QUEUE_PROBE);
  await redisSingleton.disconnect();
  await queueRedisSingleton.disconnect();
});

describe('cache and queue Redis client separation', () => {
  test('each singleton writes only to its configured endpoint', async () => {
    const cache = await redisSingleton.getClient();
    const queue = await queueRedisSingleton.getClient();
    await cache.set(CACHE_PROBE, 'cache');
    await queue.set(QUEUE_PROBE, 'queue');

    expect(await cache.get(CACHE_PROBE)).toBe('cache');
    expect(await queue.get(QUEUE_PROBE)).toBe('queue');
    expect(await cache.get(QUEUE_PROBE)).toBeNull();
    expect(await queue.get(CACHE_PROBE)).toBeNull();
  });
});
