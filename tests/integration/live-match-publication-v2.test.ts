import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  clearLiveMatchCheckpointDesiredV2,
  LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES,
  LIVE_MATCH_MAX_FIXTURES,
  LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE,
  liveMatchActiveEventKey,
  liveMatchDeskKey,
  liveMatchDetailKey,
  liveMatchDetailManifestKey,
  promotePreviousLiveMatchV2,
  publishLiveMatchDeskV2,
  publishLiveMatchDetailV2,
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchCheckpointLastAtV2,
  readLiveMatchDeskV2,
  readLiveMatchDeskPointerV2,
  readLiveMatchDetailV2,
  readLiveMatchDetailPointerV2,
  restoreLiveMatchDeskCheckpointV2,
  restoreLiveMatchDetailCheckpointV2,
  markLiveMatchDeskCheckpointedV2,
  setLiveMatchActiveEventV2,
  setLiveMatchCheckpointDesiredV2,
  touchLiveMatchDeskV2,
  type MatchDeskPublication,
} from '../../src/cache/live-match-publication-v2';
import type { MatchDeskFixture, MatchFixtureDetail } from '../../src/services/live-match-v2';
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
const prefix = 'llm:data:v2:fpl:live-match:';

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
        totalPoints: 6,
        stats: [
          { identifier: 'bps', value: bps, points: 0, pointsModification: null },
          { identifier: 'goals_scored', value: 1, points: 5, pointsModification: null },
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

describe('Live Matches V2 Redis publications', () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await redis.quit();
  });

  test('promotes desk atomically and retains the previous complete version', async () => {
    const first = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      staleAt: '2026-08-29T10:01:15.000Z',
      redis,
    });
    const current = await readLiveMatchDeskV2({ ...scope, redis });
    expect(current?.publication.publicationId).toBe(first.publication.publicationId);
    expect(current?.servedFrom).toBe('REDIS_CURRENT');

    const second = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      staleAt: '2026-08-29T10:01:45.000Z',
      previous: current,
      redis,
    });
    expect(second.publication.generation).toBeGreaterThan(first.publication.generation);
    expect((await readLiveMatchDeskV2({ ...scope, redis }))?.fixtures[0]?.homeScore).toBe(1);
    expect(await redis.get(liveMatchDeskKey(scope, 'previous'))).toContain(
      first.publication.publicationId,
    );
  });

  test('persists forced checkpoint urgency for a boundary publication', async () => {
    const publication = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const forced = await setLiveMatchCheckpointDesiredV2({
      kind: 'desk',
      publication: publication.publication,
      force: true,
      redis,
    });
    expect(forced.force).toBe(true);

    const kept = await setLiveMatchCheckpointDesiredV2({
      kind: 'desk',
      publication: publication.publication,
      force: false,
      redis,
    });
    expect(kept.force).toBe(true);
  });

  test('carries boundary urgency onto a newer desired publication', async () => {
    const older = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const newer = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });

    const current = await setLiveMatchCheckpointDesiredV2({
      kind: 'desk',
      publication: newer.publication,
      force: false,
      redis,
    });
    expect(current.generation).toBe(newer.publication.generation);
    expect(current.force).toBe(false);

    const urgent = await setLiveMatchCheckpointDesiredV2({
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
    const current = await publishLiveMatchDeskV2({
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
      publishLiveMatchDeskV2({
        ...scope,
        state: 'LIVE_ACTIVE',
        fixtures: oversized,
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDeskV2({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED' });
    expect((await readLiveMatchDeskV2({ ...scope, redis }))?.publication.publicationId).toBe(
      current.publication.publicationId,
    );
  });

  test('rotates a freshly validated active desk for a stale cold publisher', async () => {
    const first = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const second = await publishLiveMatchDeskV2({
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
    const previous = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const active = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });
    await redis.set(`${active.publication.desk.key}:meta`, 'corrupt');
    const fallback = await readLiveMatchDeskV2({ ...scope, redis });
    expect(fallback?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(fallback?.publication.publicationId).toBe(previous.publication.publicationId);

    const repaired = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(2)],
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: fallback,
      redis,
    });
    await redis.set(`${repaired.publication.desk.key}:meta`, 'corrupt-again');
    const retained = await readLiveMatchDeskV2({ ...scope, redis });
    expect(retained?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(retained?.publication.publicationId).toBe(previous.publication.publicationId);
    expect(retained?.fixtures[0]?.homeScore).toBe(0);
  });

  test('does not let an older event move the active-event pointer backwards', async () => {
    await setLiveMatchActiveEventV2({
      season: scope.season,
      eventId: scope.eventId + 1,
      redis,
    });
    await setLiveMatchActiveEventV2({ ...scope, redis });

    expect(await redis.get(liveMatchActiveEventKey(scope.season))).toBe(String(scope.eventId + 1));
  });

  test('touches only heartbeat timestamps without changing generation or content revision', async () => {
    const published = await publishLiveMatchDeskV2({
      ...scope,
      state: 'BETWEEN_FIXTURES',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      staleAt: '2026-08-29T10:12:00.000Z',
      redis,
    });
    const touched = await touchLiveMatchDeskV2({
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

  test('records a Redis checkpoint watermark with the exact publication CAS', async () => {
    const published = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const marked = await markLiveMatchDeskCheckpointedV2(
      published.publication,
      '2026-08-29T10:00:05.000Z',
      redis,
    );
    expect(marked?.checkpointedAt).toBe('2026-08-29T10:00:05.000Z');
    expect(await readLiveMatchCheckpointLastAtV2({ ...scope, kind: 'desk', redis })).toBe(
      '2026-08-29T10:00:05.000Z',
    );
  });

  test('reuses unchanged detail fixture item across detail generations', async () => {
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const first = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const firstItemKey = first.publication.fixtures[0]?.key;
    const second = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV2({ ...scope, redis }),
      redis,
    });
    const secondItemKey = second.publication.fixtures[0]?.key;
    expect(secondItemKey).not.toBe(firstItemKey);

    const third = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:01:00.000Z',
      previous: await readLiveMatchDetailV2({ ...scope, redis }),
      redis,
    });
    expect(third.publication.fixtures[0]?.key).toBe(secondItemKey);
    expect(
      (await readLiveMatchDetailV2({ ...scope, redis }))?.fixtures[0]?.players[0]?.stats[0]?.value,
    ).toBe(35);
  });

  test('rejects oversized fixture detail before it can replace current', async () => {
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const current = await publishLiveMatchDetailV2({
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
      publishLiveMatchDetailV2({
        ...scope,
        observedDeskGeneration: desk.publication.generation,
        fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
        fixtures: oversized,
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDetailV2({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED' });
    expect((await readLiveMatchDetailV2({ ...scope, redis }))?.publication.publicationId).toBe(
      current.publication.publicationId,
    );
  });

  test('rejects detail whose durable fixture envelope exceeds the total limit', async () => {
    const desk = await publishLiveMatchDeskV2({
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
      publishLiveMatchDetailV2({
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
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const first = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      previous: null,
      redis,
    });
    const second = await publishLiveMatchDetailV2({
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
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const previous = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(30),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const active = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV2({ ...scope, redis }),
      redis,
    });
    const activeItem = active.publication.fixtures[0];
    if (!activeItem) throw new Error('active detail item is missing');
    await redis.set(`${activeItem.key}:meta`, 'corrupt');
    const fallback = await readLiveMatchDetailV2({ ...scope, redis });
    expect(fallback?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(fallback?.publication.publicationId).toBe(previous.publication.publicationId);

    const repaired = await publishLiveMatchDetailV2({
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
    const retained = await readLiveMatchDetailV2({ ...scope, redis });
    expect(retained?.servedFrom).toBe('REDIS_PREVIOUS');
    expect(retained?.publication.publicationId).toBe(previous.publication.publicationId);
    expect(retained?.fixtures[0]?.players[0]?.stats[0]?.value).toBe(30);
  });

  test('CAS-promotes desk previous and retains the replaced current as previous', async () => {
    const first = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const second = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });

    const result = await promotePreviousLiveMatchV2({ ...scope, kind: 'desk', redis });

    expect(result.status).toBe('promoted');
    expect(
      (await readLiveMatchDeskPointerV2({ ...scope, redis }, 'active'))?.publication.publicationId,
    ).toBe(first.publication.publicationId);
    expect(
      (await readLiveMatchDeskPointerV2({ ...scope, redis }, 'previous'))?.publication
        .publicationId,
    ).toBe(second.publication.publicationId);
  });

  test('never rolls a finalized desk back to previous', async () => {
    await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(0)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const final = await publishLiveMatchDeskV2({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });

    expect(await promotePreviousLiveMatchV2({ ...scope, kind: 'desk', redis })).toMatchObject({
      status: 'changed',
      publication: null,
    });
    expect((await readLiveMatchDeskV2({ ...scope, redis }))?.publication.publicationId).toBe(
      final.publication.publicationId,
    );
  });

  test('restores the exact desk checkpoint identity after Redis current loss', async () => {
    await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const checkpoint = await readLiveMatchDeskPointerV2({ ...scope, redis }, 'active');
    if (!checkpoint) throw new Error('desk checkpoint fixture is missing');
    await redis.del(liveMatchDeskKey(scope, 'active'));
    await redis.set(checkpoint.publication.desk.key, 'corrupt-desk-payload');
    await redis.set(`${checkpoint.publication.desk.key}:meta`, 'corrupt-desk-metadata');

    const result = await restoreLiveMatchDeskCheckpointV2({ checkpoint, redis });

    expect(result.published).toBe(true);
    expect(result.publication.publicationId).toBe(checkpoint.publication.publicationId);
    expect(result.publication.generation).toBe(checkpoint.publication.generation);

    const activeItemTtl = await redis.pttl(checkpoint.publication.desk.key);
    const staleRestore = await restoreLiveMatchDeskCheckpointV2({ checkpoint, redis });
    expect(staleRestore.published).toBe(false);
    expect(await redis.pttl(checkpoint.publication.desk.key)).toBe(activeItemTtl);
  });

  test('restores exact detail manifest and immutable item key from checkpoint', async () => {
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const checkpoint = await readLiveMatchDetailPointerV2({ ...scope, redis }, 'active');
    const item = checkpoint?.publication.fixtures[0];
    if (!checkpoint || !item) throw new Error('detail checkpoint fixture is missing');
    await redis.del(
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailManifestKey(scope, checkpoint.publication.generation),
    );
    await redis.del(item.key, `${item.key}:meta`);

    const result = await restoreLiveMatchDetailCheckpointV2({ checkpoint, redis });
    const restored = await readLiveMatchDetailPointerV2({ ...scope, redis }, 'active');

    expect(result.published).toBe(true);
    expect(result.publication.publicationId).toBe(checkpoint.publication.publicationId);
    expect(restored?.publication.fixtures[0]?.key).toBe(item.key);
  });

  test('restores compatible provisional detail behind a newer desk generation', async () => {
    const firstDesk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: firstDesk.publication.generation,
      fixtureIdentityRevision: firstDesk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const firstDetail = await readLiveMatchDetailV2({ ...scope, redis });
    if (!firstDetail) throw new Error('first detail publication is missing');
    const newerDesk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(2)],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });
    expect(newerDesk.publication.generation).toBeGreaterThan(firstDesk.publication.generation);

    await redis.del(liveMatchDetailKey(scope, 'active'));
    const restored = await restoreLiveMatchDetailCheckpointV2({
      checkpoint: firstDetail,
      redis,
    });

    expect(restored.published).toBe(true);
    expect(restored.publication.observedDeskGeneration).toBe(firstDesk.publication.generation);
    expect((await readLiveMatchDetailV2({ ...scope, redis }))?.publication.publicationId).toBe(
      firstDetail.publication.publicationId,
    );
  });

  test('does not let a provisional detail publication supersede final detail', async () => {
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'FINALIZED',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const finalDetail = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      finalized: true,
      redis,
    });
    const provisional = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(40),
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDetailV2({ ...scope, redis }),
      finalized: false,
      redis,
    });
    expect(provisional.published).toBe(false);
    expect(provisional.publication.publicationId).toBe(finalDetail.publication.publicationId);
    expect((await readLiveMatchDetailV2({ ...scope, redis }))?.publication.finalized).toBe(true);
    expect(
      (await readLiveMatchDetailV2({ ...scope, redis }))?.fixtures[0]?.players[0]?.stats[0]?.value,
    ).toBe(35);
  });

  test('does not promote detail beside a newer incompatible desk publication', async () => {
    const desk = await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [deskFixture(1)],
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    const detail = await publishLiveMatchDetailV2({
      ...scope,
      observedDeskGeneration: desk.publication.generation,
      fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
      fixtures: detailFixtures(35),
      sourceCheckedAt: '2026-08-29T10:00:00.000Z',
      redis,
    });
    await publishLiveMatchDeskV2({
      ...scope,
      state: 'LIVE_ACTIVE',
      fixtures: [{ ...deskFixture(2), homeTeamName: 'Home FC Renamed' }],
      sourceCheckedAt: '2026-08-29T10:00:30.000Z',
      previous: await readLiveMatchDeskV2({ ...scope, redis }),
      redis,
    });

    await expect(
      publishLiveMatchDetailV2({
        ...scope,
        observedDeskGeneration: desk.publication.generation,
        fixtureIdentityRevision: desk.publication.revisions.fixtureIdentity.revision,
        fixtures: detailFixtures(40),
        sourceCheckedAt: '2026-08-29T10:00:30.000Z',
        previous: await readLiveMatchDetailV2({ ...scope, redis }),
        redis,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PROMOTE_CHANGED' });
    expect((await readLiveMatchDetailV2({ ...scope, redis }))?.publication.publicationId).toBe(
      detail.publication.publicationId,
    );
  });

  test('coalesces checkpoint intent and protects a final desk from non-final intent', async () => {
    const finalPublication = {
      contractVersion: 'live-matches-v2',
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
    const desired = await setLiveMatchCheckpointDesiredV2({
      kind: 'desk',
      publication: finalPublication,
      redis,
    });
    expect(desired.final).toBe(true);
    const kept = await setLiveMatchCheckpointDesiredV2({
      kind: 'desk',
      publication: {
        ...finalPublication,
        publicationId: '00000000-0000-4000-8000-000000000002',
        state: 'LIVE_ACTIVE',
      },
      redis,
    });
    expect(kept.publicationId).toBe(desired.publicationId);
    const newerFinalKept = await setLiveMatchCheckpointDesiredV2({
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
      (await readLiveMatchCheckpointDesiredV2({ ...scope, kind: 'desk', redis }))?.publicationId,
    ).toBe(desired.publicationId);
    await clearLiveMatchCheckpointDesiredV2(desired, redis);
    expect(await readLiveMatchCheckpointDesiredV2({ ...scope, kind: 'desk', redis })).toBeNull();
  });
});
