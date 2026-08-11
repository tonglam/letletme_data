import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { queueRedisSingleton } from '../../src/queues/redis';
import {
  buildCoordinationMigrationPairs,
  moveCoordinationKeys,
} from '../../src/services/deployment-redis-transition.service';

const CACHE_PROBE = 'llm:data:test:cache-client-probe';
const QUEUE_PROBE = 'llm:queue:coordination:test:queue-client-probe';
const RETIRED_COORDINATION_PROBE = 'llm:v3:queue:coordination:test:transition';
const CANONICAL_COORDINATION_PROBE = 'llm:queue:coordination:test:transition';

afterAll(async () => {
  const cache = await redisSingleton.getClient();
  const queue = await queueRedisSingleton.getClient();
  await cache.unlink(CACHE_PROBE);
  await queue.unlink(QUEUE_PROBE, RETIRED_COORDINATION_PROBE, CANONICAL_COORDINATION_PROBE);
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

  test('atomically moves retained coordination state with its TTL and rejects conflicts', async () => {
    const queue = await queueRedisSingleton.getClient();
    await queue.unlink(RETIRED_COORDINATION_PROBE, CANONICAL_COORDINATION_PROBE);
    await queue.set(RETIRED_COORDINATION_PROBE, 'preserved', 'PX', 60_000);
    const beforeTtl = await queue.pttl(RETIRED_COORDINATION_PROBE);

    expect(
      await moveCoordinationKeys(
        queue,
        buildCoordinationMigrationPairs([RETIRED_COORDINATION_PROBE]),
      ),
    ).toBe(1);

    expect(await queue.exists(RETIRED_COORDINATION_PROBE)).toBe(0);
    expect(await queue.get(CANONICAL_COORDINATION_PROBE)).toBe('preserved');
    const afterTtl = await queue.pttl(CANONICAL_COORDINATION_PROBE);
    expect(afterTtl).toBeGreaterThan(0);
    expect(afterTtl).toBeLessThanOrEqual(beforeTtl);

    await queue.set(RETIRED_COORDINATION_PROBE, 'source');
    expect(
      moveCoordinationKeys(queue, buildCoordinationMigrationPairs([RETIRED_COORDINATION_PROBE])),
    ).rejects.toThrow('target_exists');
    expect(await queue.get(RETIRED_COORDINATION_PROBE)).toBe('source');
    expect(await queue.get(CANONICAL_COORDINATION_PROBE)).toBe('preserved');

    await queue.unlink(RETIRED_COORDINATION_PROBE, CANONICAL_COORDINATION_PROBE);
    expect(
      await moveCoordinationKeys(
        queue,
        buildCoordinationMigrationPairs([RETIRED_COORDINATION_PROBE]),
      ),
    ).toBe(0);
    expect(await queue.exists(CANONICAL_COORDINATION_PROBE)).toBe(0);
  });
});
