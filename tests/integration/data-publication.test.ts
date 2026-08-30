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
  liveV2Key,
  entryLiveInputFromFplPicks,
  entryLiveV2Key,
  markLivePublicationCheckpointedV2,
  publishEntryLiveFinalResultV2,
  publishEntryLiveInputV2,
  publishLivePublicationV2,
  restoreLivePublicationV2Checkpoint,
  readLiveCheckpointDesiredV2,
  readEntryLiveInputV2,
  readLivePublicationV2,
  setLiveCheckpointDesiredV2,
  touchLivePublicationV2,
} from '../../src/cache/live-publication-v2';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import type { RawFPLEntryEventPicksResponse } from '../../src/clients/fpl';

const CORE_SCOPE = { dataset: 'fpl:core' as const, seasonCode: '9899' };
const LIVE_SCOPE = {
  season: '9899',
  eventId: 38,
};
const ENTRY_SCOPE = {
  ...LIVE_SCOPE,
  entryId: 6953,
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

function entryPicks(eventId: number): RawFPLEntryEventPicksResponse {
  return {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: eventId,
      points: 60,
      total_points: 60,
      rank: 100,
      overall_rank: 1_000,
      bank: 10,
      value: 1_000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 5,
    },
    picks: Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    })),
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
    await unlinkPattern(redis, 'llm:data:v2:fpl:live:9899:38:*');
    await unlinkPattern(redis, 'llm:data:v2:fpl:entry-live:9899:38:6953:*');
  });

  afterAll(async () => {
    await unlinkPattern(redis, 'llm:data:fpl:core:9899:*');
    await unlinkPattern(redis, 'llm:data:v2:fpl:live:9899:38:*');
    await unlinkPattern(redis, 'llm:data:v2:fpl:entry-live:9899:38:6953:*');
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

  test('publishes V2 current and retains the previous complete publication', async () => {
    const first = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    const second = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:30.000Z'),
      eventLives: [],
      fixtures: [],
      previous: first.publication,
      redis,
    });

    expect(first.publication.contractVersion).toBe('live-points-v2');
    expect(second.publication.generation).toBeGreaterThan(first.publication.generation);
    expect(second.previous?.publicationId).toBe(first.publication.publicationId);
    expect((await readLivePublicationV2(LIVE_SCOPE, redis))?.publication.publicationId).toBe(
      second.publication.publicationId,
    );
    expect(await redis.exists(liveV2Key(LIVE_SCOPE, 'previous'))).toBe(1);
  });

  test('coalesces a checkpoint window while advancing the desired generation', async () => {
    const first = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    const second = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:30.000Z'),
      eventLives: [
        {
          eventId: LIVE_SCOPE.eventId,
          elementId: 1,
          createdAt: new Date('2026-08-09T04:00:00.000Z'),
          minutes: 1,
          goalsScored: 0,
          assists: 0,
          cleanSheets: 0,
          goalsConceded: 0,
          ownGoals: 0,
          penaltiesSaved: 0,
          penaltiesMissed: 0,
          yellowCards: 0,
          redCards: 0,
          saves: 0,
          bonus: 0,
          bps: 0,
          defensiveContribution: 0,
          starts: true,
          expectedGoals: '0',
          expectedAssists: '0',
          expectedGoalInvolvements: '0',
          expectedGoalsConceded: '0',
          inDreamTeam: false,
          totalPoints: 1,
        },
      ],
      fixtures: [],
      previous: first.publication,
      redis,
    });

    await setLiveCheckpointDesiredV2(first.publication, '2026-08-09T04:00:00.000Z', redis);
    await setLiveCheckpointDesiredV2(second.publication, '2026-08-09T04:00:30.000Z', redis);

    await expect(readLiveCheckpointDesiredV2(LIVE_SCOPE, redis)).resolves.toMatchObject({
      publicationId: second.publication.publicationId,
      generation: second.publication.generation,
      requestedAt: '2026-08-09T04:00:00.000Z',
    });
  });

  test('a corrupt current item is rejected and the reader serves the previous publication', async () => {
    const first = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    const second = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:30.000Z'),
      eventLives: [],
      fixtures: [],
      previous: first.publication,
      redis,
    });
    await redis.set(second.publication.items.eventLive.key, JSON.stringify([{ broken: true }]));

    const recovered = await readLivePublicationV2(LIVE_SCOPE, redis);
    expect(recovered?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(recovered?.publication.publicationId).toBe(first.publication.publicationId);
  });

  test('a corrupt current pointer does not block the next complete publication', async () => {
    const first = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    await redis.set(liveV2Key(LIVE_SCOPE, 'active'), 'not-json');

    const recovered = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:30.000Z'),
      eventLives: [],
      fixtures: [],
      previous: first.publication,
      redis,
    });

    expect(recovered.published).toBe(true);
    expect(recovered.publication.generation).toBeGreaterThan(first.publication.generation);
    expect((await readLivePublicationV2(LIVE_SCOPE, redis))?.publication.publicationId).toBe(
      recovered.publication.publicationId,
    );
  });

  test('rebuild-current restores a corrupted current item at the checkpoint generation', async () => {
    const published = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    await redis.set(published.publication.items.eventLive.key, '{"corrupt":true}');

    const restored = await restoreLivePublicationV2Checkpoint({
      checkpoint: {
        publication: published.publication,
        eventLives: [],
        fixtures: [],
        servedFrom: 'POSTGRES_CHECKPOINT',
      },
      redis,
    });

    expect(restored.published).toBe(true);
    expect(restored.publication.publicationId).toBe(published.publication.publicationId);
    expect(restored.publication.generation).toBe(published.publication.generation);
    expect((await readLivePublicationV2(LIVE_SCOPE, redis))?.servedFrom).toBe('REDIS_CURRENT');
  });

  test('a finalized publication cannot be superseded by a provisional candidate, even if an item is corrupt', async () => {
    const finalized = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'FINALIZED',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    await redis.set(finalized.publication.items.eventLive.key, '{"corrupt":true}');

    const provisional = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'LIVE_ACTIVE',
      sourceCheckedAt: new Date('2026-08-09T04:00:30.000Z'),
      eventLives: [],
      fixtures: [],
      previous: finalized.publication,
      redis,
    });

    expect(provisional.published).toBe(false);
    expect(provisional.publication.publicationId).toBe(finalized.publication.publicationId);
    expect(JSON.parse((await redis.get(liveV2Key(LIVE_SCOPE, 'active'))) ?? '{}')).toMatchObject({
      state: 'FINALIZED',
      publicationId: finalized.publication.publicationId,
    });
  });

  test('finalized manifest retention survives heartbeat and checkpoint CAS updates', async () => {
    const finalized = await publishLivePublicationV2({
      ...LIVE_SCOPE,
      state: 'FINALIZED',
      sourceCheckedAt: new Date('2026-08-09T04:00:00.000Z'),
      eventLives: [],
      fixtures: [],
      redis,
    });
    const initialTtl = await redis.pttl(liveV2Key(LIVE_SCOPE, 'active'));
    expect(initialTtl).toBeGreaterThan(0);

    await touchLivePublicationV2(
      finalized.publication,
      '2026-08-09T04:00:30.000Z',
      '2026-08-09T04:01:00.000Z',
      redis,
    );
    const touchedTtl = await redis.pttl(liveV2Key(LIVE_SCOPE, 'active'));
    expect(touchedTtl).toBeGreaterThan(0);
    expect(touchedTtl).toBeLessThanOrEqual(initialTtl);

    await markLivePublicationCheckpointedV2(
      finalized.publication,
      '2026-08-09T04:01:00.000Z',
      redis,
    );
    const checkpointedTtl = await redis.pttl(liveV2Key(LIVE_SCOPE, 'active'));
    expect(checkpointedTtl).toBeGreaterThan(0);
    expect(checkpointedTtl).toBeLessThanOrEqual(touchedTtl);
  });

  test('a finalized entry input cannot be superseded by a provisional picks refresh', async () => {
    const provisionalInput = entryLiveInputFromFplPicks(
      explicitSeasonRef(ENTRY_SCOPE.season),
      ENTRY_SCOPE.eventId,
      ENTRY_SCOPE.entryId,
      entryPicks(ENTRY_SCOPE.eventId),
      '2026-08-09T04:00:00.000Z',
    );
    await publishEntryLiveInputV2({
      ...ENTRY_SCOPE,
      input: provisionalInput,
      sourceCheckedAt: '2026-08-09T04:00:00.000Z',
      generationFloor: 0,
      redis,
    });
    const finalized = await publishEntryLiveFinalResultV2({
      ...ENTRY_SCOPE,
      sourceCheckedAt: '2026-08-09T04:01:00.000Z',
      dataCheckedAt: '2026-08-09T04:01:00.000Z',
      finalResult: {
        score: { eventPoints: 62, totalPoints: 1_234 },
        picks: provisionalInput.picksBase.picks,
        automaticSubs: [],
      },
      redis,
    });

    expect(finalized.publication.state).toBe('FINAL');
    const downgraded = await publishEntryLiveInputV2({
      ...ENTRY_SCOPE,
      input: provisionalInput,
      sourceCheckedAt: '2026-08-09T04:02:00.000Z',
      generationFloor: 0,
      redis,
    });

    expect(downgraded.published).toBe(false);
    expect(downgraded.publication.state).toBe('FINAL');
    expect((await readEntryLiveInputV2(ENTRY_SCOPE, redis))?.publication.state).toBe('FINAL');
    expect(await redis.exists(entryLiveV2Key(ENTRY_SCOPE, 'previous'))).toBe(1);
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
      input(1, PUBLICATION_IDS.one, '2026-08-09T01:00:00.000Z'),
      { redis },
    );

    const retired = await retireActiveDataPublication(CORE_SCOPE, redis);
    expect(retired?.publicationId).toBe(PUBLICATION_IDS.one);
    expect(await redis.exists(activeDataPublicationKey(CORE_SCOPE))).toBe(0);
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
