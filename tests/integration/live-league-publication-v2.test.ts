import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  LIVE_LEAGUE_CONTRACT_VERSION,
  liveLeagueV2Key,
  liveLeagueV2ItemKey,
  parseLiveLeaguePublicationV2Manifest,
  publishLiveLeaguePublicationV2,
  renewLiveLeagueFinalLeaseV2,
  setLiveLeagueCheckpointDesiredV2,
  readLiveLeagueCheckpointDesiredV2,
  type LeagueLiveManifest,
} from '../../src/cache/live-league-publication-v2';

const redis = new Redis({
  host: process.env.CACHE_REDIS_HOST,
  port: Number(process.env.CACHE_REDIS_PORT),
  password: process.env.CACHE_REDIS_PASSWORD,
  db: Number(process.env.CACHE_REDIS_DB),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

const scope = {
  season: '2627',
  eventId: 9876,
  tournamentId: 3,
  scope: 'CLASSIC',
} as const;

const publication: LeagueLiveManifest = {
  contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
  publicationId: '00000000-0000-4000-8000-000000000001',
  generation: 1,
  ...scope,
  state: 'LIVE_ACTIVE',
  globalRef: {
    publicationId: '00000000-0000-4000-8000-000000000002',
    generation: 1,
  },
  revisions: {
    roster: 'a'.repeat(64),
    scoreCore: 'b'.repeat(64),
    fixtureIdentity: 'c'.repeat(64),
    entryInputSet: 'd'.repeat(64),
    identity: 'e'.repeat(64),
    officialRank: null,
    rules: 'f'.repeat(64),
    algorithm: '0'.repeat(64),
    schedule: null,
    averageSide: null,
    content: '1'.repeat(64),
  },
  times: {
    sourceCheckedAt: '2026-08-30T00:00:00.000Z',
    contentUpdatedAt: '2026-08-30T00:00:00.000Z',
    publishedAt: '2026-08-30T00:00:00.000Z',
    checkpointedAt: null,
    expectedNextCheckAt: null,
  },
  counts: {
    expected: 0,
    published: 0,
    ready: 0,
    noPicks: 0,
  },
  items: {
    index: {
      name: 'index',
      key: 'test:index',
      type: 'string',
      count: 0,
      bytes: 0,
      sha256: '2'.repeat(64),
    },
    payload: {
      name: 'payload',
      key: 'test:payload',
      type: 'string',
      count: 0,
      bytes: 0,
      sha256: '3'.repeat(64),
    },
  },
};

const desiredKey = liveLeagueV2Key(scope, 'checkpoint-desired');

const promotionScope = {
  season: '2627',
  eventId: 9877,
  tournamentId: 3003,
  scope: 'CLASSIC',
} as const;

const promotionRevisions = (content: string) => ({
  roster: 'a'.repeat(64),
  scoreCore: 'b'.repeat(64),
  fixtureIdentity: 'c'.repeat(64),
  entryInputSet: 'd'.repeat(64),
  identity: 'e'.repeat(64),
  officialRank: null,
  rules: 'f'.repeat(64),
  algorithm: '0'.repeat(64),
  schedule: null,
  averageSide: null,
  content,
});

function promotionInput(state: 'LIVE_ACTIVE' | 'FINALIZED', content: string, second: string) {
  return {
    scope: promotionScope,
    state,
    sourceCheckedAt: '2026-08-30T00:00:00.000Z',
    contentUpdatedAt: `2026-08-30T00:00:${second}.000Z`,
    expectedNextCheckAt: '2026-08-30T00:00:30.000Z',
    globalRef: {
      publicationId: '00000000-0000-4000-8000-000000000012',
      generation: 1,
    },
    revisions: promotionRevisions(content),
    counts: { expected: 0, published: 0, ready: 0, noPicks: 0 },
    index: [],
    payload: {},
    redis,
  } as const;
}

const promotionItemKeys = (generation: number): string[] =>
  (['index', 'payload'] as const).flatMap((name) => {
    const key = liveLeagueV2ItemKey(promotionScope, generation, name);
    return [key, `${key}:meta`];
  });

const promotionKeys = [
  liveLeagueV2Key(promotionScope, 'active'),
  liveLeagueV2Key(promotionScope, 'previous'),
  liveLeagueV2Key(promotionScope, 'sequence'),
  ...[1, 2, 3, 4].flatMap(promotionItemKeys),
];

describe('Live League V2 checkpoint desired marker', () => {
  beforeEach(async () => {
    await redis.del(desiredKey);
  });

  afterAll(async () => {
    await redis.del(desiredKey);
    await redis.del(...promotionKeys);
    await redis.quit();
  });

  test('replaces a malformed high-generation marker instead of fencing recovery', async () => {
    await redis.set(
      desiredKey,
      JSON.stringify({
        contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
        season: scope.season,
        eventId: scope.eventId,
        tournamentId: scope.tournamentId,
        scope: 'H2H_STANDINGS',
        publicationId: 'not-a-publication-id',
        generation: 999_999,
        requestedAt: '2026-08-30T00:00:00.000Z',
        notBefore: null,
        force: false,
      }),
    );

    const desired = await setLiveLeagueCheckpointDesiredV2(
      publication,
      publication.times.publishedAt,
      { redis },
    );

    expect(desired.publicationId).toBe(publication.publicationId);
    expect(desired.generation).toBe(publication.generation);
    expect(await readLiveLeagueCheckpointDesiredV2(scope, redis)).toMatchObject({
      publicationId: publication.publicationId,
      generation: publication.generation,
      scope: publication.scope,
    });
  });

  test('keeps a finalized pointer as a fence when its immutable items are damaged', async () => {
    await redis.del(...promotionKeys);

    const first = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '1'.repeat(64), '01'),
    );
    const second = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '2'.repeat(64), '02'),
    );
    const finalized = await publishLiveLeaguePublicationV2(
      promotionInput('FINALIZED', '3'.repeat(64), '03'),
    );

    expect(first.published).toBe(true);
    expect(second.published).toBe(true);
    expect(finalized.published).toBe(true);
    expect(finalized.publication.state).toBe('FINALIZED');

    await redis.del(
      finalized.publication.items.index.key,
      `${finalized.publication.items.index.key}:meta`,
      finalized.publication.items.payload.key,
      `${finalized.publication.items.payload.key}:meta`,
    );

    const provisional = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '4'.repeat(64), '04'),
    );

    expect(provisional.published).toBe(false);
    expect(provisional.publication.state).toBe('FINALIZED');
    expect(
      parseLiveLeaguePublicationV2Manifest(
        await redis.get(liveLeagueV2Key(promotionScope, 'active')),
        promotionScope,
      )?.state,
    ).toBe('FINALIZED');
  });

  test('retires the superseded previous generation after a third promotion', async () => {
    await redis.del(...promotionKeys);

    const first = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '6'.repeat(64), '06'),
    );
    const second = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '7'.repeat(64), '07'),
    );

    expect(await redis.exists(...promotionItemKeys(first.publication.generation))).toBe(4);

    const third = await publishLiveLeaguePublicationV2(
      promotionInput('LIVE_ACTIVE', '8'.repeat(64), '08'),
    );

    expect(await redis.exists(...promotionItemKeys(first.publication.generation))).toBe(0);
    expect(await redis.exists(...promotionItemKeys(second.publication.generation))).toBe(4);
    expect(await redis.exists(...promotionItemKeys(third.publication.generation))).toBe(4);
    expect(
      parseLiveLeaguePublicationV2Manifest(
        await redis.get(liveLeagueV2Key(promotionScope, 'previous')),
        promotionScope,
      )?.generation,
    ).toBe(second.publication.generation);
    expect(
      parseLiveLeaguePublicationV2Manifest(
        await redis.get(liveLeagueV2Key(promotionScope, 'active')),
        promotionScope,
      )?.generation,
    ).toBe(third.publication.generation);
  });

  test('renews a complete final league lease without rewriting its manifest', async () => {
    await redis.del(...promotionKeys);
    const finalized = await publishLiveLeaguePublicationV2(
      promotionInput('FINALIZED', '5'.repeat(64), '05'),
    );
    const activeKey = liveLeagueV2Key(promotionScope, 'active');
    const observedRaw = await redis.get(activeKey);
    if (!observedRaw) throw new Error('final league active pointer is missing');
    const keys = [
      activeKey,
      finalized.publication.items.index.key,
      `${finalized.publication.items.index.key}:meta`,
      finalized.publication.items.payload.key,
      `${finalized.publication.items.payload.key}:meta`,
    ];
    await Promise.all(keys.map((key) => redis.pexpire(key, 1_000)));

    const renewed = await renewLiveLeagueFinalLeaseV2({
      publication: finalized.publication,
      observedRaw,
      redis,
    });
    expect(renewed.status).toBe('renewed');
    expect(renewed.ttlMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(await redis.get(activeKey)).toBe(observedRaw);
  });
});
