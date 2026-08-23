import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import { publishManagerLiveCacheMonotonically } from '../../src/cache/manager-live-publication';

const KEYS = {
  rows: 'llm:test:manager-live-cache:rows',
  metadata: 'llm:test:manager-live-cache:metadata',
  orders: 'llm:test:manager-live-cache:orders',
  markers: 'llm:test:manager-live-cache:markers',
} as const;
const ALL_KEYS = Object.values(KEYS);

function redisClient(): Redis {
  return new Redis({
    host: process.env.CACHE_REDIS_HOST,
    port: Number(process.env.CACHE_REDIS_PORT),
    password: process.env.CACHE_REDIS_PASSWORD,
    db: Number(process.env.CACHE_REDIS_DB),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

describe('manager-live monotonic cache publication', () => {
  const redis = redisClient();

  beforeAll(async () => {
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.unlink(...ALL_KEYS);
  });

  afterAll(async () => {
    await redis.unlink(...ALL_KEYS);
    await redis.quit();
  });

  const publish = (
    publicationOrder: string,
    rows: ReadonlyArray<{
      entryId: number;
      payload: string;
      overallRankPublicationOrder?: string;
    }>,
    metadataPayload: string,
  ) =>
    publishManagerLiveCacheMonotonically(redis, {
      rowKey: KEYS.rows,
      metadataKey: KEYS.metadata,
      rowOrderKey: KEYS.orders,
      overallRankMarkerKey: KEYS.markers,
      publicationOrder,
      rows,
      metadataField: 'entry-summary',
      metadataPayload,
      ttlSeconds: 120,
    });

  test('rejects a delayed older write for the same manager and metadata field', async () => {
    const newerOrder = '2026-08-23T12:00:00.000200Z';
    const olderOrder = '2026-08-23T12:00:00.000100Z';
    await publish(
      newerOrder,
      [
        {
          entryId: 1,
          payload: 'newer-row',
          overallRankPublicationOrder: '2026-08-23T11:59:59.000200Z',
        },
      ],
      'newer-metadata',
    );

    expect(
      await publish(olderOrder, [{ entryId: 1, payload: 'older-row' }], 'older-metadata'),
    ).toEqual([]);
    expect(await redis.hget(KEYS.rows, '1')).toBe('newer-row');
    expect(await redis.hget(KEYS.orders, '1')).toBe(newerOrder);
    expect(await redis.hget(KEYS.metadata, 'entry-summary')).toBe('newer-metadata');
    expect(await redis.hget(KEYS.markers, '1')).toBe('2026-08-23T11:59:59.000200Z');
  });

  test('still publishes a disjoint older batch without regressing shared metadata', async () => {
    await publish(
      '2026-08-23T12:00:00.000300Z',
      [{ entryId: 2, payload: 'row-two' }],
      'newest-metadata',
    );

    expect(
      await publish(
        '2026-08-23T12:00:00.000250Z',
        [{ entryId: 1, payload: 'row-one' }],
        'older-metadata',
      ),
    ).toEqual([1]);
    expect(await redis.hget(KEYS.rows, '1')).toBe('row-one');
    expect(await redis.hget(KEYS.rows, '2')).toBe('row-two');
    expect(await redis.hget(KEYS.metadata, 'entry-summary')).toBe('newest-metadata');
  });

  test('concurrent writers converge on the greatest database publication order', async () => {
    await Promise.all([
      publish(
        '2026-08-23T12:00:00.000400Z',
        [{ entryId: 1, payload: 'older-concurrent-row' }],
        'older-concurrent-metadata',
      ),
      publish(
        '2026-08-23T12:00:00.000401Z',
        [{ entryId: 1, payload: 'newer-concurrent-row' }],
        'newer-concurrent-metadata',
      ),
    ]);

    expect(await redis.hget(KEYS.rows, '1')).toBe('newer-concurrent-row');
    expect(await redis.hget(KEYS.orders, '1')).toBe('2026-08-23T12:00:00.000401Z');
    expect(await redis.hget(KEYS.metadata, 'entry-summary')).toBe('newer-concurrent-metadata');
  });
});
