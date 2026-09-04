import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  clearLiveMatchCheckpointDesiredV3,
  LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES,
  LIVE_MATCH_MAX_FIXTURES,
  LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE,
  liveMatchActiveEventKey,
  liveMatchDeskKey,
  liveMatchDetailKey,
  liveMatchDetailManifestKey,
  promotePreviousLiveMatchV3,
  publishLiveMatchDeskV3,
  publishLiveMatchDetailV3,
  readLiveMatchCheckpointDesiredV3,
  readLiveMatchCheckpointLastAtV3,
  readLiveMatchDeskV3,
  readLiveMatchDeskPointerV3,
  readLiveMatchDetailFenceV3,
  readLiveMatchDetailV3,
  readLiveMatchDetailPointerV3,
  readLiveMatchDeskFenceV3,
  restoreLiveMatchEquivalentFinalPairV3,
  restoreLiveMatchDeskCheckpointV3,
  restoreLiveMatchDetailCheckpointV3,
  renewLiveMatchDeskFinalLeaseV3,
  renewLiveMatchDetailFinalLeaseV3,
  markLiveMatchDeskCheckpointedV3,
  setLiveMatchActiveEventV3,
  setLiveMatchCheckpointDesiredV3,
  touchLiveMatchDeskV3,
  type MatchDeskPublication,
} from '../../src/cache/live-match-publication-v3';
import type { MatchDeskFixture, MatchFixtureDetail } from '../../src/services/live-match-v3';
import { canonicalJson } from '../../src/utils/content-hash';

const redis = new Redis({
  host: process.env.CACHE_REDIS_HOST,
  port: Number(process.env.CACHE_REDIS_PORT),
  password: process.env.CACHE_REDIS_PASSWORD,
  db: Number(process.env.CACHE_REDIS_DB),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const scope = { season: '2627', eventId: 9876 } as const;
const prefix = 'llm:data:v3:fpl:live-match:';

const deskFixture = (homeScore: number): MatchDeskFixture => ({
  fixtureId: 401,
  eventId: scope.eventId,
  homeTeamId: 10,
  homeTeamName: 'Home FC',
  homeTeamShortName: 'HOM',
  awayTeamId: 20,
  awayTeamName: 'Away FC',
  awayTeamShortName: 'AWA',
  homeScore,
  awayScore: 0,
  kickoffTime: '2026-08-29T10:00:00.000Z',
  minutes: homeScore > 0 ? 90 : 0,
  started: homeScore > 0,
  finished: false,
  finishedProvisional: false,
});

const detailFixtures = (bps: number): MatchFixtureDetail[] => [
  {
    fixtureId: 401,
    players: [
      {
        id: 101,
        webName: 'Player One',
        position: 3,
        teamId: 10,
        price: 50,
        totalPoints: 5,
        stats: [
          { identifier: 'bps', value: bps, awardedPoints: 0 },
          { identifier: 'goals_scored', value: 1, awardedPoints: 5 },
        ],
      },
    ],
  },
];

async function clean(): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(
      cursor,
      'MATCH',
      `${prefix}*${scope.eventId}*`,
      'COUNT',
      200,
    );
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  keys.push(liveMatchActiveEventKey(scope.season));
  if (keys.length > 0) await redis.del(...keys);
}

describe('Live Matches V3 Redis publications', () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await redis.quit();
  });

  test('promotes desk atomically and retains the previous complete version', async () => {
    const first = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      staleAt: '2026-08-29T10:01:15.000Z',
      redis,
    });
    const current = await readLiveMatchDeskV3({ ...scope, redis });
    expect(current?.publication.publicationId).toBe(first.publication.publicationId);
    expect(current?.servedFrom).toBe('REDIS_CURRENT');

    const second = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      staleAt: '2026-08-29T10:01:45.000Z',
      previous: current,
      redis,
    });
    expect(second.publication.generation).toBeGreaterThan(first.publication.generation);
    expect((await readLiveMatchDeskV3({ ...scope, redis }))?.fixtures[0]?.homeScore).toBe(1);
    expect(await redis.get(liveMatchDeskKey(scope, 'previous'))).toContain(
      first.publication.publicationId,
    );
  });

  test('restores an equivalent final pair atomically, preserves sequence floors, and is idempotent', async () => {
    const deskPublished = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const detailPublished = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: deskPublished.publication.generation,
      fixtureIdentityRevision: deskPublished.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:01.000Z',
      finalized: true,
      redis,
    });
    const deskCheckpoint = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active');
    const detailCheckpoint = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');
    if (!deskCheckpoint || !detailCheckpoint) throw new Error('final pair fixture is missing');
    const observedDesk = await readLiveMatchDeskFenceV3({ ...scope, redis });
    await redis.del(liveMatchDetailKey(scope, 'active'));
    const observedDetail = await readLiveMatchDetailFenceV3({ ...scope, redis });
    expect(observedDetail.observed).toBe('');
    expect(observedDetail.read).toBeNull();
    const deskSequenceKey = `${liveMatchDeskKey(scope, 'sequence')}`;
    const detailSequenceKey = `${liveMatchDetailKey(scope, 'sequence')}`;
    const deskSequenceBefore = await redis.get(deskSequenceKey);
    const detailSequenceBefore = await redis.get(detailSequenceKey);

    const restored = await restoreLiveMatchEquivalentFinalPairV3({
      deskCheckpoint,
      detailCheckpoint,
      observedDesk,
      observedDetail,
      redis,
    });
    expect(restored.status).toBe('restored');
    expect(restored.desk.publicationId).toBe(deskPublished.publication.publicationId);
    expect(restored.detail.publicationId).toBe(detailPublished.publication.publicationId);
    expect(await redis.get(deskSequenceKey)).toBe(deskSequenceBefore);
    expect(await redis.get(detailSequenceKey)).toBe(detailSequenceBefore);
    expect(
      (await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active'))?.publication
        .publicationId,
    ).toBe(detailPublished.publication.publicationId);
    expect(
      (await readLiveMatchDeskPointerV3({ ...scope, redis }, 'previous'))?.publication
        .publicationId,
    ).toBe(deskPublished.publication.publicationId);

    const secondObservedDesk = await readLiveMatchDeskFenceV3({ ...scope, redis });
    const secondObservedDetail = await readLiveMatchDetailFenceV3({ ...scope, redis });
    const second = await restoreLiveMatchEquivalentFinalPairV3({
      deskCheckpoint,
      detailCheckpoint,
      observedDesk: secondObservedDesk,
      observedDetail: secondObservedDetail,
      redis,
    });
    expect(second.status).toBe('already-canonical');
    expect(await redis.get(deskSequenceKey)).toBe(deskSequenceBefore);
    expect(await redis.get(detailSequenceKey)).toBe(detailSequenceBefore);
  });

  test('rejects a stale pair fence without changing either active pointer', async () => {
    const deskPublished = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const detailPublished = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: deskPublished.publication.generation,
      fixtureIdentityRevision: deskPublished.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:01.000Z',
      finalized: true,
      redis,
    });
    const deskCheckpoint = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active');
    const detailCheckpoint = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');
    if (!deskCheckpoint || !detailCheckpoint) throw new Error('final pair fixture is missing');
    const observedDesk = await readLiveMatchDeskFenceV3({ ...scope, redis });
    const observedDetail = await readLiveMatchDetailFenceV3({ ...scope, redis });
    const racedRaw = JSON.stringify({ race: true });
    await redis.set(liveMatchDetailKey(scope, 'active'), racedRaw);
    await expect(
      restoreLiveMatchEquivalentFinalPairV3({
        deskCheckpoint,
        detailCheckpoint,
        observedDesk,
        observedDetail,
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_EQUIVALENT_PAIR_CHANGED' });
    expect(await redis.get(liveMatchDetailKey(scope, 'active'))).toBe(racedRaw);
    expect(await redis.get(liveMatchDeskKey(scope, 'active'))).toContain(
      deskPublished.publication.publicationId,
    );
    expect(detailPublished.publication.publicationId).toBeDefined();
  });

  test('orders desk revision content time by source observation and preserves it when unchanged', async () => {
    const first = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    expect(first.publication.revisions.lifecycle.contentUpdatedAt).toBe(
      first.publication.sourceCheckedAt,
    );
    expect(first.publication.revisions.fixtureIdentity.contentUpdatedAt).toBe(
      first.publication.sourceCheckedAt,
    );
    expect(first.publication.revisions.scoreState.contentUpdatedAt).toBe(
      first.publication.sourceCheckedAt,
    );
    expect(new Date(first.publication.sourceCheckedAt).getTime()).toBeLessThanOrEqual(
      new Date(first.publication.publishedAt).getTime(),
    );

    const unchanged = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.001Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    expect(unchanged.publication.revisions).toEqual(first.publication.revisions);
    expect(unchanged.publication.publicationId).not.toBe(first.publication.publicationId);
    expect(unchanged.publication.generation).toBeGreaterThan(first.publication.generation);
    expect(new Date(unchanged.publication.sourceCheckedAt).getTime()).toBeLessThanOrEqual(
      new Date(unchanged.publication.publishedAt).getTime(),
    );

    const finalized = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.002Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    expect(finalized.publication.revisions.lifecycle.contentUpdatedAt).toBe(
      finalized.publication.sourceCheckedAt,
    );
    expect(finalized.publication.revisions.scoreState.contentUpdatedAt).toBe(
      finalized.publication.sourceCheckedAt,
    );
    expect(finalized.publication.revisions.fixtureIdentity).toEqual(
      first.publication.revisions.fixtureIdentity,
    );
    expect(new Date(finalized.publication.sourceCheckedAt).getTime()).toBeLessThanOrEqual(
      new Date(finalized.publication.publishedAt).getTime(),
    );
  });

  test('persists forced checkpoint urgency for a boundary publication', async () => {
    const publication = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const forced = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: publication.publication,
      force: true,
      redis,
    });
    expect(forced.force).toBe(true);

    const kept = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: publication.publication,
      force: false,
      redis,
    });
    expect(kept.force).toBe(true);
  });

  test('carries boundary urgency onto a newer desired publication', async () => {
    const older = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const newer = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });

    const current = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: newer.publication,
      force: false,
      redis,
    });
    expect(current.generation).toBe(newer.publication.generation);
    expect(current.force).toBe(false);

    const urgent = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: older.publication,
      force: true,
      redis,
    });
    expect(urgent.publicationId).toBe(newer.publication.publicationId);
    expect(urgent.generation).toBe(newer.publication.generation);
    expect(urgent.force).toBe(true);
  });

  test('rejects an oversized desk before it can replace current', async () => {
    const current = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const oversized = Array.from({ length: LIVE_MATCH_MAX_FIXTURES + 1 }, (_, index) => ({
      ...deskFixture(index),
      fixtureId: 10_000 + index,
    }));

    await expect(
      publishLiveMatchDeskV3({
        ...scope,
        state: 'LIVE_ACTIVE',
        fixtures: oversized,
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDeskV3({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED' });
    expect((await readLiveMatchDeskV3({ ...scope, redis }))?.publication.publicationId).toBe(
      current.publication.publicationId,
    );
  });

  test('rotates a freshly validated active desk for a stale cold publisher', async () => {
    const first = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const second = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: null,
      redis,
    });

    expect(second.publication.generation).toBeGreaterThan(first.publication.generation);
    expect(await redis.get(liveMatchDeskKey(scope, 'previous'))).toContain(
      first.publication.publicationId,
    );
  });

  test('preserves a valid desk previous when the active item is corrupt during repair', async () => {
    const previous = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const active = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    await redis.set(`${active.publication.desk.key}:meta`, 'corrupt');
    const fallback = await readLiveMatchDeskV3({ ...scope, redis });
    expect(fallback?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(fallback?.publication.publicationId).toBe(previous.publication.publicationId);

    const repaired = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(2)],
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: fallback,
      redis,
    });
    await redis.set(`${repaired.publication.desk.key}:meta`, 'corrupt-again');
    const retained = await readLiveMatchDeskV3({ ...scope, redis });
    expect(retained?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(retained?.publication.publicationId).toBe(previous.publication.publicationId);
    expect(retained?.fixtures[0]?.homeScore).toBe(0);
  });

  test('does not let an older event move the active-event pointer backwards', async () => {
    await setLiveMatchActiveEventV3({
      season: scope.season,
      eventId: scope.eventId + 1,
      redis,
    });
    await setLiveMatchActiveEventV3({ ...scope, redis });

    expect(await redis.get(liveMatchActiveEventKey(scope.season))).toBe(String(scope.eventId + 1));
  });

  test('touches only heartbeat timestamps without changing generation or content revision', async () => {
    const published = await publishLiveMatchDeskV3({
      ...scope,
      state: 'BETWEEN_FIXTURES',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      staleAt: '2026-08-29T10:12:00.000Z',
      redis,
    });
    const touched = await touchLiveMatchDeskV3({
      publication: published.publication,
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      expectedNextCheckAt: '2026-08-29T10:05:00.000Z',
      staleAt: '2026-08-29T10:12:30.000Z',
      redis,
    });
    expect(touched).toMatchObject({
      generation: published.publication.generation,
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      revisions: published.publication.revisions,
    });
  });

  test('does not let an older desk heartbeat overwrite a newer publication', async () => {
    const first = await publishLiveMatchDeskV3({
      ...scope,
      state: 'BETWEEN_FIXTURES',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const observed = await readLiveMatchDeskFenceV3({ ...scope, redis });
    const newer = await publishLiveMatchDeskV3({
      ...scope,
      state: 'BETWEEN_FIXTURES',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });

    expect(
      await touchLiveMatchDeskV3({
        publication: first.publication,
        sourceCheckedAt: '2026-08-29T10:01:00.000Z',
        expectedNextCheckAt: '2026-08-29T10:05:00.000Z',
        observedActive: observed,
        redis,
      }),
    ).toBeNull();
    expect((await readLiveMatchDeskV3({ ...scope, redis }))?.publication.publicationId).toBe(
      newer.publication.publicationId,
    );
  });

  test('records a Redis checkpoint watermark with the exact publication CAS', async () => {
    const published = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const marked = await markLiveMatchDeskCheckpointedV3(
      published.publication,
      '2026-08-29T10:00:05.000Z',
      redis,
    );
    expect(marked?.checkpointedAt).toBe('2026-08-29T10:00:05.000Z');
    expect(await readLiveMatchCheckpointLastAtV3({ ...scope, kind: 'desk', redis })).toBe(
      '2026-08-29T10:00:05.000Z',
    );
  });

  test('reuses unchanged detail fixture item across detail generations', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const first = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const firstItemKey = first.publication.fixtures[0]?.key;
    expect(first.publication.detail.contentUpdatedAt).toBe('2026-08-29T10:00:00.000Z');
    const second = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      redis,
    });
    const secondItemKey = second.publication.fixtures[0]?.key;
    expect(secondItemKey).not.toBe(firstItemKey);
    expect(second.publication.detail.contentUpdatedAt).toBe('2026-08-29T10:00:30.000Z');

    const third = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      redis,
    });
    expect(third.publication.fixtures[0]?.key).toBe(secondItemKey);
    expect(third.publication.detail.contentUpdatedAt).toBe(
      second.publication.detail.contentUpdatedAt,
    );
    expect(
      (await readLiveMatchDetailV3({ ...scope, redis }))?.fixtures[0]?.players[0]?.stats[0]?.value,
    ).toBe(35);
  });

  test('rejects oversized fixture detail before it can replace current', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const current = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const template = detailFixtures(35)[0]?.players[0];
    if (!template) throw new Error('detail template is missing');
    const oversized: MatchFixtureDetail[] = [
      {
        fixtureId: 401,
        players: Array.from({ length: LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE + 1 }, (_, index) => ({
          ...template,
          id: 10_000 + index,
        })),
      },
    ];

    await expect(
      publishLiveMatchDetailV3({
        ...scope,
        observedDeskGeneration: desk.publication.generation,
        fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
        fixtures: oversized,
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDetailV3({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED' });
    expect((await readLiveMatchDetailV3({ ...scope, redis }))?.publication.publicationId).toBe(
      current.publication.publicationId,
    );
  });

  test('rejects detail whose durable fixture envelope exceeds the total limit', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const fixtures: MatchFixtureDetail[] = Array.from({ length: 9 }, (_, index) => ({
      fixtureId: 500 + index,
      players: [
        {
          id: 20_000 + index,
          webName: 'x'.repeat(232_000),
          position: 3,
          teamId: 10,
          price: 50,
          totalPoints: 0,
          stats: [],
        },
      ],
    }));
    const initialBytes = Buffer.byteLength(canonicalJson(fixtures), 'utf8');
    const growth = LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES - initialBytes + 1;
    const firstPlayer = fixtures[0]?.players[0];
    if (!firstPlayer || growth <= 0) throw new Error('detail boundary fixture is invalid');
    fixtures[0] = {
      ...fixtures[0]!,
      players: [{ ...firstPlayer, webName: `${firstPlayer.webName}${'x'.repeat(growth)}` }],
    };
    const itemBytes = fixtures.reduce(
      (total, fixture) => total + Buffer.byteLength(canonicalJson(fixture.players), 'utf8'),
      0,
    );
    expect(itemBytes).toBeLessThanOrEqual(LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES);
    expect(Buffer.byteLength(canonicalJson(fixtures), 'utf8')).toBe(
      LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES + 1,
    );

    await expect(
      publishLiveMatchDetailV3({
        ...scope,
        observedDeskGeneration: desk.publication.generation,
        fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
        fixtures,
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED' });
  });

  test('rotates a freshly validated active detail for a stale cold publisher', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const first = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const second = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: null,
      redis,
    });

    expect(second.publication.generation).toBeGreaterThan(first.publication.generation);
    expect(await redis.get(liveMatchDetailKey(scope, 'previous'))).toContain(
      first.publication.publicationId,
    );
  });

  test('preserves a valid detail previous when the active item is corrupt during repair', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const previous = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const active = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      redis,
    });
    const activeItem = active.publication.fixtures[0];
    if (!activeItem) throw new Error('active detail item is missing');
    await redis.set(`${activeItem.key}:meta`, 'corrupt');
    const fallback = await readLiveMatchDetailV3({ ...scope, redis });
    expect(fallback?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(fallback?.publication.publicationId).toBe(previous.publication.publicationId);

    const repaired = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(40),
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: fallback,
      redis,
    });
    const repairedItem = repaired.publication.fixtures[0];
    if (!repairedItem) throw new Error('repaired detail item is missing');
    await redis.set(`${repairedItem.key}:meta`, 'corrupt-again');
    const retained = await readLiveMatchDetailV3({ ...scope, redis });
    expect(retained?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(retained?.publication.publicationId).toBe(previous.publication.publicationId);
    expect(retained?.fixtures[0]?.players[0]?.stats[0]?.value).toBe(30);
  });

  test('CAS-promotes desk previous and retains the replaced current as previous', async () => {
    const first = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const second = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });

    const result = await promotePreviousLiveMatchV3({ ...scope, kind: 'desk', redis });

    expect(result.status).toBe('promoted');
    expect(
      (await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active'))?.publication.publicationId,
    ).toBe(first.publication.publicationId);
    expect(
      (await readLiveMatchDeskPointerV3({ ...scope, redis }, 'previous'))?.publication
        .publicationId,
    ).toBe(second.publication.publicationId);
  });

  test('does not promote a future desk rollback into the eventless pointer', async () => {
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'PRE_DEADLINE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'PRE_DEADLINE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    await setLiveMatchActiveEventV3({
      season: scope.season,
      eventId: scope.eventId + 1,
      redis,
    });

    const result = await promotePreviousLiveMatchV3({
      ...scope,
      kind: 'desk',
      promoteActiveEvent: false,
      redis,
    });

    expect(result.status).toBe('promoted');
    expect(await redis.get(liveMatchActiveEventKey(scope.season))).toBe(String(scope.eventId + 1));
  });

  test('fences desk rollback when detail changes after compatibility validation', async () => {
    const firstDesk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const secondDesk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: secondDesk.publication.generation,
      fixtureIdentityRevision: secondDesk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      redis,
    });
    const observedDetail = await readLiveMatchDetailFenceV3({ ...scope, redis });
    await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: secondDesk.publication.generation,
      fixtureIdentityRevision: secondDesk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(40),
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      redis,
    });

    const result = await promotePreviousLiveMatchV3({
      ...scope,
      kind: 'desk',
      observedDetail,
      redis,
    });

    expect(result).toMatchObject({ status: 'changed', publication: null });
    expect((await readLiveMatchDeskV3({ ...scope, redis }))?.publication.publicationId).toBe(
      secondDesk.publication.publicationId,
    );
    expect(firstDesk.publication.publicationId).not.toBe(secondDesk.publication.publicationId);
  });

  test('never rolls a finalized desk back to previous', async () => {
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const final = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });

    expect(await promotePreviousLiveMatchV3({ ...scope, kind: 'desk', redis })).toMatchObject({
      status: 'changed',
      publication: null,
    });
    expect((await readLiveMatchDeskV3({ ...scope, redis }))?.publication.publicationId).toBe(
      final.publication.publicationId,
    );
  });

  test('restores the exact desk checkpoint identity after Redis current loss', async () => {
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const checkpoint = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active');
    if (!checkpoint) throw new Error('desk checkpoint fixture is missing');
    await redis.del(liveMatchDeskKey(scope, 'active'));
    await redis.set(checkpoint.publication.desk.key, 'corrupt-desk-payload');
    await redis.set(`${checkpoint.publication.desk.key}:meta`, 'corrupt-desk-metadata');

    const result = await restoreLiveMatchDeskCheckpointV3({ checkpoint, redis });

    expect(result.published).toBe(true);
    expect(result.publication.publicationId).toBe(checkpoint.publication.publicationId);
    expect(result.publication.generation).toBe(checkpoint.publication.generation);

    const activeItemTtl = await redis.pttl(checkpoint.publication.desk.key);
    const staleRestore = await restoreLiveMatchDeskCheckpointV3({ checkpoint, redis });
    expect(staleRestore.published).toBe(false);
    expect(await redis.pttl(checkpoint.publication.desk.key)).toBe(activeItemTtl);
  });

  test('does not promote the eventless pointer when restoring a pre-deadline desk', async () => {
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'PRE_DEADLINE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const checkpoint = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active');
    if (!checkpoint) throw new Error('pre-deadline desk checkpoint is missing');
    await setLiveMatchActiveEventV3({
      season: scope.season,
      eventId: scope.eventId + 1,
      redis,
    });

    await restoreLiveMatchDeskCheckpointV3({
      checkpoint,
      promoteActiveEvent: false,
      redis,
    });

    expect(await redis.get(liveMatchActiveEventKey(scope.season))).toBe(String(scope.eventId + 1));
  });

  test('restores exact detail manifest and immutable item key from checkpoint', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const checkpoint = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');
    const item = checkpoint?.publication.fixtures[0];
    if (!checkpoint || !item) throw new Error('detail checkpoint fixture is missing');
    await redis.del(
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailManifestKey(scope, checkpoint.publication.generation),
    );
    await redis.del(item.key, `${item.key}:meta`);

    const result = await restoreLiveMatchDetailCheckpointV3({ checkpoint, redis });
    const restored = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');

    expect(result.published).toBe(true);
    expect(result.publication.publicationId).toBe(checkpoint.publication.publicationId);
    expect(restored?.publication.fixtures[0]?.key).toBe(item.key);
  });

  test('restores compatible provisional detail behind a newer desk generation', async () => {
    const firstDesk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: firstDesk.publication.generation,
      fixtureIdentityRevision: firstDesk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const firstDetail = await readLiveMatchDetailV3({ ...scope, redis });
    if (!firstDetail) throw new Error('first detail publication is missing');
    const newerDesk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(2)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });
    expect(newerDesk.publication.generation).toBeGreaterThan(firstDesk.publication.generation);

    await redis.del(liveMatchDetailKey(scope, 'active'));
    const restored = await restoreLiveMatchDetailCheckpointV3({
      checkpoint: firstDetail,
      redis,
    });

    expect(restored.published).toBe(true);
    expect(restored.publication.observedDeskGeneration).toBe(firstDesk.publication.generation);
    expect((await readLiveMatchDetailV3({ ...scope, redis }))?.publication.publicationId).toBe(
      firstDetail.publication.publicationId,
    );
  });

  test('does not let a provisional detail publication supersede final detail', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const finalDetail = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      finalized: true,
      redis,
    });
    const provisional = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(40),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      finalized: false,
      redis,
    });
    expect(provisional.published).toBe(false);
    expect(provisional.publication.publicationId).toBe(finalDetail.publication.publicationId);
    expect((await readLiveMatchDetailV3({ ...scope, redis }))?.publication.finalized).toBe(true);
    expect(
      (await readLiveMatchDetailV3({ ...scope, redis }))?.fixtures[0]?.players[0]?.stats[0]?.value,
    ).toBe(35);
  });

  test('renews final desk and detail leases without changing publication pointers', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const detail = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      finalized: true,
      redis,
    });
    const deskActiveKey = liveMatchDeskKey(scope, 'active');
    const detailActiveKey = liveMatchDetailKey(scope, 'active');
    const deskRaw = await redis.get(deskActiveKey);
    const detailRaw = await redis.get(detailActiveKey);
    if (!deskRaw || !detailRaw) throw new Error('final Match pointers are missing');
    const keys = [
      deskActiveKey,
      desk.publication.desk.key,
      `${desk.publication.desk.key}:meta`,
      detailActiveKey,
      liveMatchDetailManifestKey(scope, detail.publication.generation),
      ...detail.publication.fixtures.flatMap((item) => [item.key, `${item.key}:meta`]),
    ];
    await Promise.all(keys.map((key) => redis.pexpire(key, 1_000)));

    const deskRenewed = await renewLiveMatchDeskFinalLeaseV3({
      publication: desk.publication,
      observedRaw: deskRaw,
      redis,
    });
    const detailRenewed = await renewLiveMatchDetailFinalLeaseV3({
      publication: detail.publication,
      observedRaw: detailRaw,
      redis,
    });
    expect(deskRenewed.status).toBe('renewed');
    expect(detailRenewed.status).toBe('renewed');
    expect(deskRenewed.ttlMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(detailRenewed.ttlMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(await redis.get(deskActiveKey)).toBe(deskRaw);
    expect(await redis.get(detailActiveKey)).toBe(detailRaw);
  });

  test('does not promote detail beside a newer incompatible desk publication', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const detail = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDeskV3({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [{ ...deskFixture(2), homeTeamName: 'Home FC Renamed' }],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV3({ ...scope, redis }),
      redis,
    });

    await expect(
      publishLiveMatchDetailV3({
        ...scope,
        observedDeskGeneration: desk.publication.generation,
        fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
        fixtures: detailFixtures(40),
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDetailV3({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PROMOTE_CHANGED' });
    expect((await readLiveMatchDetailV3({ ...scope, redis }))?.publication.publicationId).toBe(
      detail.publication.publicationId,
    );
  });

  test('coalesces checkpoint intent and protects a final desk from non-final intent', async () => {
    const finalPublication = {
      contractVersion: 'live-matches-v3',
      publicationId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      season: scope.season,
      eventId: scope.eventId,
      state: 'FINALIZED',
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      publishedAt: '2026-08-29T10:00:00.000Z',
      checkpointedAt: null,
      expectedNextCheckAt: null,
      staleAt: null,
      revisions: {
        lifecycle: { revision: 'a'.repeat(64), contentUpdatedAt: '2026-08-29T10:00:00.000Z' },
        fixtureIdentity: { revision: 'b'.repeat(64), contentUpdatedAt: '2026-08-29T10:00:00.000Z' },
        scoreState: { revision: 'c'.repeat(64), contentUpdatedAt: '2026-08-29T10:00:00.000Z' },
      },
      desk: {
        name: 'desk',
        key: 'postgresql:placeholder',
        type: 'string',
        count: 1,
        bytes: 1,
        sha256: 'd'.repeat(64),
      },
    } as unknown as MatchDeskPublication;
    const desired = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: finalPublication,
      redis,
    });
    expect(desired.final).toBe(true);
    const kept = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: {
        ...finalPublication,
        publicationId: '00000000-0000-4000-8000-000000000002',
        state: 'LIVE_ACTIVE',
      },
      redis,
    });
    expect(kept.publicationId).toBe(desired.publicationId);
    const newerFinalKept = await setLiveMatchCheckpointDesiredV3({
      kind: 'desk',
      publication: {
        ...finalPublication,
        publicationId: '00000000-0000-4000-8000-000000000003',
        generation: 2,
      },
      redis,
    });
    expect(newerFinalKept.publicationId).toBe(desired.publicationId);
    expect(newerFinalKept.generation).toBe(desired.generation);
    expect(
      (await readLiveMatchCheckpointDesiredV3({ ...scope, kind: 'desk', redis }))?.publicationId,
    ).toBe(desired.publicationId);
    await clearLiveMatchCheckpointDesiredV3(desired, redis);
    expect(await readLiveMatchCheckpointDesiredV3({ ...scope, kind: 'desk', redis })).toBeNull();
  });

  test('replaces only the exact stale final detail obligation during cutover', async () => {
    const desk = await publishLiveMatchDeskV3({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const stale = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      finalized: true,
      redis,
    });
    const staleDesired = await setLiveMatchCheckpointDesiredV3({
      kind: 'detail',
      publication: stale.publication,
      force: true,
      redis,
    });
    const candidate = await publishLiveMatchDetailV3({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      finalized: true,
      previous: await readLiveMatchDetailV3({ ...scope, redis }),
      redis,
    });

    const replaced = await setLiveMatchCheckpointDesiredV3({
      kind: 'detail',
      publication: candidate.publication,
      force: true,
      replaceFinalizedForCutover: {
        expectedPublicationId: staleDesired.publicationId,
        expectedGeneration: staleDesired.generation,
      },
      redis,
    });
    expect(replaced.publicationId).toBe(candidate.publication.publicationId);
    expect(replaced.generation).toBe(candidate.publication.generation);

    const raced = await setLiveMatchCheckpointDesiredV3({
      kind: 'detail',
      publication: stale.publication,
      force: true,
      replaceFinalizedForCutover: {
        expectedPublicationId: staleDesired.publicationId,
        expectedGeneration: staleDesired.generation,
      },
      redis,
    });
    expect(raced.publicationId).toBe(candidate.publication.publicationId);
    expect(raced.generation).toBe(candidate.publication.generation);
  });
});
