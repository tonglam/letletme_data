import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  LIVE_LEAGUE_CONTRACT_VERSION,
  liveLeagueV2Key,
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

describe('Live League V2 checkpoint desired marker', () => {
  beforeEach(async () => {
    await redis.del(desiredKey);
  });

  afterAll(async () => {
    await redis.del(desiredKey);
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

    const desired = await setLiveLeagueCheckpointDesiredV2(publication, undefined, { redis });

    expect(desired.publicationId).toBe(publication.publicationId);
    expect(desired.generation).toBe(publication.generation);
    expect(await readLiveLeagueCheckpointDesiredV2(scope, redis)).toMatchObject({
      publicationId: publication.publicationId,
      generation: publication.generation,
      scope: publication.scope,
    });
  });
});
