import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  clearLiveMatchCheckpointDesiredV2,
  LIVE_MATCH_MAX_FIXTURES,
  LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE,
  liveMatchActiveEventKey,
  liveMatchDeskKey,
  liveMatchDetailKey,
  publishLiveMatchDeskV2,
  publishLiveMatchDetailV2,
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchCheckpointLastAtV2,
  readLiveMatchDeskV2,
  readLiveMatchDetailV2,
  markLiveMatchDeskCheckpointedV2,
  setLiveMatchActiveEventV2,
  setLiveMatchCheckpointDesiredV2,
  touchLiveMatchDeskV2,
  type MatchDeskPublication,
} from '../../src/cache/live-match-publication-v2';
import type { MatchDeskFixture, MatchFixtureDetail } from '../../src/services/live-match-v2';

const redis = new Redis({ host: '127.0.0.1', port: 6379, db: 15 });
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
        players: Array.from(
          { length: LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE + 1 },
          (_, index) => ({ ...template, id: 10_000 + index }),
        ),
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
