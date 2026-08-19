import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  activeDataPublicationKey,
  DATA_PUBLICATION_RETIRED_TTL_MS,
  DATA_PUBLICATION_STAGING_TTL_MS,
  dataPublicationItemKey,
  publishDataRevision,
  readActiveDataPublication,
  retireActiveDataPublication,
  type PublishDataRevisionInput,
} from '../../src/cache/data-publication';
import {
  publishLiveSnapshotCache,
  readLiveSnapshotCache,
} from '../../src/cache/live-snapshot-cache';

const CORE_SCOPE = { dataset: 'fpl:core' as const, seasonCode: '9899' };
const LIVE_SCOPE = {
  dataset: 'fpl:live' as const,
  seasonCode: '9899',
  eventId: 38,
};

const PUBLICATION_IDS = {
  one: '00000000-0000-4000-8000-000000000001',
  two: '00000000-0000-4000-8000-000000000002',
  three: '00000000-0000-4000-8000-000000000003',
  four: '00000000-0000-4000-8000-000000000004',
} as const;

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

async function unlinkPattern(redis: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

function input(
  revision: number,
  publicationId: string,
  sourceCheckedAt: string,
  value: unknown = [{ id: revision }],
): PublishDataRevisionInput {
  return {
    ...CORE_SCOPE,
    revision,
    publicationId,
    sourceCheckedAt: new Date(sourceCheckedAt),
    state: 'active',
    items: [
      { name: 'events', value },
      { name: 'teams', value: [] },
      { name: 'players', value: [] },
      { name: 'phases', value: [] },
      { name: 'fixtures', value: [] },
      { name: 'currentEventId', value: null },
      { name: 'selectionRules', value: null },
    ],
  };
}

async function expectPermanent(redis: Redis, key: string): Promise<void> {
  expect(await redis.pttl(key)).toBe(-1);
}

async function expectBoundedTtl(redis: Redis, key: string, maximum: number): Promise<void> {
  const ttl = await redis.pttl(key);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(maximum);
}

describe('immutable Redis publication', () => {
  const redis = redisClient();

  beforeAll(async () => {
    await redis.connect();
  });

  beforeEach(async () => {
    await unlinkPattern(redis, 'llm:data:fpl:core:9899:*');
    await unlinkPattern(redis, 'llm:data:fpl:live:9899:*');
  });

  afterAll(async () => {
    await unlinkPattern(redis, 'llm:data:fpl:core:9899:*');
    await unlinkPattern(redis, 'llm:data:fpl:live:9899:*');
    await redis.quit();
  });

  test('publishes one complete revision with a permanent manifest and items', async () => {
    const result = await publishDataRevision(
      input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'),
      { redis },
    );

    expect(result.status).toBe('published');
    expect(result.previousManifest).toBeNull();
    expect(await readActiveDataPublication(CORE_SCOPE, redis)).toMatchObject({
      manifest: { revision: 1, publicationId: PUBLICATION_IDS.one },
      items: { events: [{ id: 1 }], currentEventId: null },
    });
    await expectPermanent(redis, activeDataPublicationKey(CORE_SCOPE));
    for (const item of result.manifest.items) await expectPermanent(redis, item.key);
  });

  test('publishes exactly one canonical two-item live contract', async () => {
    const result = await publishLiveSnapshotCache(
      {
        season: LIVE_SCOPE.seasonCode,
        eventId: LIVE_SCOPE.eventId,
        state: 'live',
        eventLives: [],
        fixtures: [],
      },
      {
        redis,
        revision: 5,
        publicationId: PUBLICATION_IDS.four,
        sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      },
    );

    expect(result.manifest.items.map((item) => item.name)).toEqual(['eventLive', 'fixtures']);
    expect(
      await readLiveSnapshotCache(LIVE_SCOPE.seasonCode, LIVE_SCOPE.eventId, redis),
    ).toMatchObject({
      eventLives: [],
      fixtures: [],
    });
  });

  test('a crash after staging leaves the prior revision active and the stage bounded', async () => {
    await publishDataRevision(input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'), {
      redis,
    });

    await expect(
      publishDataRevision(input(2, PUBLICATION_IDS.two, '2026-08-09T02:00:00.000Z'), {
        redis,
        afterStage: async () => {
          throw new Error('simulated process exit before pointer swap');
        },
      }),
    ).rejects.toThrow('simulated process exit');

    expect((await readActiveDataPublication(CORE_SCOPE, redis))?.manifest.revision).toBe(1);
    await expectBoundedTtl(
      redis,
      dataPublicationItemKey(CORE_SCOPE, 2, 'events'),
      DATA_PUBLICATION_STAGING_TTL_MS,
    );
  });

  test('activation atomically swaps the pointer and bounds the retired revision', async () => {
    const first = await publishDataRevision(
      input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'),
      { redis },
    );
    const second = await publishDataRevision(
      input(2, PUBLICATION_IDS.two, '2026-08-09T02:00:00.000Z'),
      { redis },
    );

    expect(second.previousManifest?.publicationId).toBe(PUBLICATION_IDS.one);
    expect((await readActiveDataPublication(CORE_SCOPE, redis))?.manifest.revision).toBe(2);
    for (const item of first.manifest.items) {
      await expectBoundedTtl(redis, item.key, DATA_PUBLICATION_RETIRED_TTL_MS);
    }
    for (const item of second.manifest.items) await expectPermanent(redis, item.key);
  });

  test('rejects stale ordering while retaining its staged TTL', async () => {
    await publishDataRevision(input(3, PUBLICATION_IDS.three, '2026-08-09T03:00:00.000Z'), {
      redis,
    });
    const stale = await publishDataRevision(
      input(4, PUBLICATION_IDS.four, '2026-08-09T02:00:00.000Z'),
      { redis },
    );

    expect(stale.status).toBe('stale');
    expect(stale.previousManifest?.revision).toBe(3);
    expect((await readActiveDataPublication(CORE_SCOPE, redis))?.manifest.revision).toBe(3);
    await expectBoundedTtl(
      redis,
      dataPublicationItemKey(CORE_SCOPE, 4, 'events'),
      DATA_PUBLICATION_STAGING_TTL_MS,
    );
  });

  test('an exact retry is idempotent and cannot add a TTL to active items', async () => {
    const candidate = input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z');
    const first = await publishDataRevision(candidate, { redis });
    const retry = await publishDataRevision(candidate, { redis });

    expect(retry.status).toBe('published');
    expect(retry.manifest).toEqual(first.manifest);
    for (const item of retry.manifest.items) await expectPermanent(redis, item.key);

    await expect(
      publishDataRevision(
        input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z', [{ id: 999 }]),
        { redis },
      ),
    ).rejects.toMatchObject({ code: 'DATA_PUBLICATION_STAGE_CONFLICT' });
    expect((await readActiveDataPublication(CORE_SCOPE, redis))?.items.events).toEqual([{ id: 1 }]);
    for (const item of first.manifest.items) await expectPermanent(redis, item.key);
  });

  test('readers fail closed for missing, corrupted, or wrongly typed data', async () => {
    const published = await publishDataRevision(
      input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'),
      { redis },
    );
    const eventKey = published.manifest.items.find((item) => item.name === 'events')?.key;
    if (!eventKey) throw new Error('events key missing from test publication');

    await redis.set(eventKey, JSON.stringify([{ id: 9 }]));
    expect(await readActiveDataPublication(CORE_SCOPE, redis)).toBeNull();

    await unlinkPattern(redis, 'llm:data:fpl:core:9899:*');
    await redis.hset(activeDataPublicationKey(CORE_SCOPE), 'manifest', 'wrong-type');
    expect(await readActiveDataPublication(CORE_SCOPE, redis)).toBeNull();
  });

  test('retirement removes the pointer and gives every former active item a bounded TTL', async () => {
    const published = await publishDataRevision(
      {
        ...LIVE_SCOPE,
        revision: 1,
        publicationId: PUBLICATION_IDS.one,
        sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
        state: 'settled',
        items: [
          { name: 'eventLive', value: [{ elementId: 1 }] },
          { name: 'fixtures', value: [] },
        ],
      },
      { redis },
    );

    const retired = await retireActiveDataPublication(LIVE_SCOPE, redis);
    expect(retired?.publicationId).toBe(PUBLICATION_IDS.one);
    expect(await redis.exists(activeDataPublicationKey(LIVE_SCOPE))).toBe(0);
    for (const item of published.manifest.items) {
      await expectBoundedTtl(redis, item.key, DATA_PUBLICATION_RETIRED_TTL_MS);
    }
  });

  test('beforeActivate=false leaves no pointer when there was no prior publication', async () => {
    const result = await publishDataRevision(
      input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'),
      { redis, beforeActivate: async () => false },
    );

    expect(result.status).toBe('stale');
    expect(await readActiveDataPublication(CORE_SCOPE, redis)).toBeNull();
    await expectBoundedTtl(
      redis,
      dataPublicationItemKey(CORE_SCOPE, 1, 'events'),
      DATA_PUBLICATION_STAGING_TTL_MS,
    );
  });
});
