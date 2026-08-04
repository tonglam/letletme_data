import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  createLiveSnapshotCache,
  type LiveSnapshotCachePayload,
} from '../../src/cache/live-snapshot-cache';
import { redisSingleton } from '../../src/cache/singleton';
import {
  prepareLiveSnapshot,
  type LiveSnapshotReferenceData,
} from '../../src/services/live-snapshot.service';
import type { RawFPLFixture } from '../../src/types';
import { mockEventLiveResponseFixture } from '../fixtures/event-lives.fixtures';
import { mockRawFPLFixture1 } from '../fixtures/fixtures.fixtures';

const SEASON = '2526';
const EVENT_ID = 37;
const KEYS = [
  `EventLive:${SEASON}:${EVENT_ID}`,
  `Fixtures:${SEASON}:${EVENT_ID}`,
  `LiveFixture:${SEASON}:${EVENT_ID}`,
  `LiveFixtureV2:${SEASON}:${EVENT_ID}`,
  `LiveBonus:${SEASON}:${EVENT_ID}`,
  `LiveBonusV2:${SEASON}:${EVENT_ID}`,
  `LiveSnapshotMeta:${SEASON}:${EVENT_ID}`,
];
let previousActiveSeason: string | null = null;

function referenceData(): LiveSnapshotReferenceData {
  return {
    season: SEASON,
    nameById: new Map([
      [4, 'Burnley'],
      [12, 'Liverpool'],
    ]),
    shortNameById: new Map([
      [4, 'BUR'],
      [12, 'LIV'],
    ]),
    positionById: new Map([
      [4, 16],
      [12, 1],
    ]),
    playerTeamById: new Map([
      [350, 12],
      [234, 4],
      [567, 12],
    ]),
  };
}

function payload(score: number, checkedAt: Date): LiveSnapshotCachePayload {
  const rawFixture: RawFPLFixture = {
    ...mockRawFPLFixture1,
    event: EVENT_ID,
    started: true,
    finished: false,
    finished_provisional: false,
    minutes: 55,
    team_h_score: score,
    team_a_score: 1,
    stats: [
      ...mockRawFPLFixture1.stats,
      {
        identifier: 'bps',
        h: [
          { element: 350, value: 45 },
          { element: 567, value: 5 },
        ],
        a: [{ element: 234, value: 28 }],
      },
    ],
  };
  const prepared = prepareLiveSnapshot(
    EVENT_ID,
    mockEventLiveResponseFixture,
    [rawFixture],
    referenceData(),
    [rawFixture.id],
  );
  return {
    season: prepared.season,
    eventId: EVENT_ID,
    state: prepared.state,
    eventLives: prepared.eventLives.eventLives,
    fixtures: prepared.fixtures,
    liveFixtures: prepared.fixtureViews.legacy,
    liveFixturesV2: prepared.fixtureViews.v2,
    liveBonus: prepared.liveBonus,
    liveBonusV2: prepared.liveBonusV2,
    checkedAt,
  };
}

describe('coordinated live snapshot Redis integration', () => {
  beforeAll(async () => {
    const redis = await redisSingleton.getClient();
    previousActiveSeason = await redis.get('Season:active');
  });

  beforeEach(async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', SEASON);
    await redis.del(...KEYS);
    const staging = await redis.keys(`*:${SEASON}:${EVENT_ID}:staging:*`);
    if (staging.length > 0) await redis.del(...staging);
  });

  afterAll(async () => {
    const redis = await redisSingleton.getClient();
    const staging = await redis.scan('0', 'MATCH', `*:${SEASON}:${EVENT_ID}:staging:*`);
    await redis.del(...KEYS, ...staging[1]);
    if (previousActiveSeason === null) {
      await redis.del('Season:active');
    } else {
      await redis.set('Season:active', previousActiveSeason);
    }
    await redisSingleton.disconnect();
  });

  test('publishes no-expiry views and keeps metadata aligned under concurrent refreshes', async () => {
    const redis = await redisSingleton.getClient();
    const cache = createLiveSnapshotCache({
      getRedisClient: async () => redis,
      getSeason: async () => SEASON,
      getAuthoritativeSeason: async () => SEASON,
    });

    let signalOlderStaged!: () => void;
    let releaseOlder!: () => void;
    const olderStaged = new Promise<void>((resolve) => {
      signalOlderStaged = resolve;
    });
    const olderMayCommit = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const scoreTwoPromise = cache.publish(payload(2, new Date('2025-08-15T20:00:00.000Z')), {
      beforeCommit: async () => {
        signalOlderStaged();
        await olderMayCommit;
      },
    });
    await olderStaged;
    const scoreThree = await cache.publish(payload(3, new Date('2025-08-15T20:00:01.000Z')));
    releaseOlder();
    const scoreTwo = await scoreTwoPromise;

    const meta = await cache.get(EVENT_ID);
    expect(meta).not.toBeNull();
    expect(scoreThree.stale).toBe(false);
    expect(scoreTwo.stale).toBe(true);
    expect(meta!.revision).toBe(scoreThree.meta.revision);

    const fixtureJson = await redis.hget(`Fixtures:${SEASON}:${EVENT_ID}`, '1');
    const liveFixtureJson = await redis.hget(`LiveFixtureV2:${SEASON}:${EVENT_ID}`, '12');
    expect(fixtureJson).not.toBeNull();
    expect(liveFixtureJson).not.toBeNull();
    const fixture = JSON.parse(fixtureJson!) as { teamHScore: number };
    const liveFixture = JSON.parse(liveFixtureJson!) as {
      Playing: Array<{ fixtureId: number; teamScore: number }>;
    };
    expect(liveFixture.Playing[0]).toMatchObject({
      fixtureId: 1,
      teamScore: fixture.teamHScore,
    });
    expect(fixture.teamHScore).toBe(3);
    expect(scoreTwo.meta.revision).toBe(meta!.revision);

    for (const key of KEYS) {
      expect(await redis.exists(key)).toBe(1);
      expect(await redis.ttl(key)).toBe(-1);
    }

    expect(await redis.keys(`*:${SEASON}:${EVENT_ID}:staging:*`)).toEqual([]);
  });

  test('replaces malformed metadata objects and decoded primitives', async () => {
    const redis = await redisSingleton.getClient();
    const cache = createLiveSnapshotCache({
      getRedisClient: async () => redis,
      getSeason: async () => SEASON,
      getAuthoritativeSeason: async () => SEASON,
    });
    const metaKey = `LiveSnapshotMeta:${SEASON}:${EVENT_ID}`;

    await redis.set(
      metaKey,
      JSON.stringify({
        ...payload(3, new Date('2025-08-15T20:00:01.000Z')),
        schemaVersion: 1,
        season: SEASON,
        revision: 'a'.repeat(24),
        state: 'live',
        publishedAt: '9999-99-99T99:99:99.999Z',
        checkedAt: '9999-99-99T99:99:99.999Z',
        eventLiveCount: 1,
        fixtureCount: 1,
        fixtureTeamCount: 1,
        bonusTeamCount: 0,
      }),
    );
    const fromObject = await cache.publish(payload(4, new Date('2025-08-15T20:00:02.000Z')));
    expect(fromObject).toMatchObject({ changed: true, stale: false });

    await redis.set(metaKey, '7');
    const fromPrimitive = await cache.publish(payload(5, new Date('2025-08-15T20:00:03.000Z')));
    expect(fromPrimitive).toMatchObject({ changed: true, stale: false });
    expect((await cache.get(EVENT_ID))?.revision).toBe(fromPrimitive.meta.revision);
    expect(await redis.keys(`*:${SEASON}:${EVENT_ID}:staging:*`)).toEqual([]);
  });

  test('preserves identical owned fixture derivatives but retires for a score correction', async () => {
    const redis = await redisSingleton.getClient();
    const cache = createLiveSnapshotCache({
      getRedisClient: async () => redis,
      getSeason: async () => SEASON,
      getAuthoritativeSeason: async () => SEASON,
    });
    const initial = payload(3, new Date('2025-08-15T20:00:01.000Z'));
    await cache.publish(initial);

    const unchanged = await cache.refreshFixtureDerivatives(
      EVENT_ID,
      initial.fixtures,
      initial.liveBonusV2,
    );
    expect(unchanged).toEqual({ eventId: EVENT_ID, owned: true, retired: false });
    expect(await redis.exists(`LiveSnapshotMeta:${SEASON}:${EVENT_ID}`)).toBe(1);
    expect(await redis.exists(`Fixtures:${SEASON}:${EVENT_ID}`)).toBe(1);

    const correctedFixtures = initial.fixtures.map((fixture) => ({
      ...fixture,
      teamHScore: (fixture.teamHScore ?? 0) + 1,
    }));
    const corrected = await cache.refreshFixtureDerivatives(
      EVENT_ID,
      correctedFixtures,
      initial.liveBonusV2,
    );
    expect(corrected).toEqual({ eventId: EVENT_ID, owned: true, retired: true });
    for (const prefix of [
      'EventLive',
      'LiveFixture',
      'LiveFixtureV2',
      'LiveBonus',
      'LiveSnapshotMeta',
    ]) {
      expect(await redis.exists(`${prefix}:${SEASON}:${EVENT_ID}`)).toBe(0);
    }
    const correctedFixture = JSON.parse(
      (await redis.hget(`Fixtures:${SEASON}:${EVENT_ID}`, String(correctedFixtures[0].id)))!,
    ) as { teamHScore: number };
    expect(correctedFixture.teamHScore).toBe(correctedFixtures[0].teamHScore);
    expect(await redis.hgetall(`LiveBonusV2:${SEASON}:${EVENT_ID}`)).toEqual({
      '12': JSON.stringify(initial.liveBonusV2['12']),
      '4': JSON.stringify(initial.liveBonusV2['4']),
    });
  });

  test('retires an owned snapshot for a late fixture-derived bonus correction', async () => {
    const redis = await redisSingleton.getClient();
    const cache = createLiveSnapshotCache({
      getRedisClient: async () => redis,
      getSeason: async () => SEASON,
      getAuthoritativeSeason: async () => SEASON,
    });
    const initial = payload(3, new Date('2025-08-15T20:00:01.000Z'));
    await cache.publish(initial);

    const corrected = await cache.refreshFixtureDerivatives(EVENT_ID, initial.fixtures, {
      '12': { '350': 99 },
    });
    expect(corrected).toEqual({ eventId: EVENT_ID, owned: true, retired: true });
    expect(await redis.exists(`LiveSnapshotMeta:${SEASON}:${EVENT_ID}`)).toBe(0);
    expect(await redis.hgetall(`LiveBonusV2:${SEASON}:${EVENT_ID}`)).toEqual({
      '12': JSON.stringify({ '350': 99 }),
    });
  });
});
