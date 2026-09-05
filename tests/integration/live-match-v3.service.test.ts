import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import type { LiveSnapshotReferenceData } from '../../src/services/live-coherent-fetch';
import {
  liveMatchDeskKey,
  readLiveMatchDeskFenceV3,
  readLiveMatchDeskV3,
  readLiveMatchDetailFenceV3,
  readLiveMatchDetailV3,
} from '../../src/cache/live-match-publication-v3';
import {
  liveMatchStaleAtForCadence,
  syncLiveMatchesV3FromObservation,
} from '../../src/services/live-match-v3.service';
import type { RawFPLFixture, RawFPLEventLiveElement } from '../../src/types';

const redis = new Redis({
  host: process.env.CACHE_REDIS_HOST,
  port: Number(process.env.CACHE_REDIS_PORT),
  password: process.env.CACHE_REDIS_PASSWORD,
  db: Number(process.env.CACHE_REDIS_DB),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const season = { seasonId: 2026, seasonCode: '2627' } as const;
const eventId = 2;
const prefix = 'llm:data:v3:fpl:live-match:';

const fixture = (bps: number): RawFPLFixture => ({
  code: 10401,
  event: eventId,
  finished: false,
  finished_provisional: false,
  id: 401,
  kickoff_time: '2026-08-29T10:00:00.000Z',
  minutes: 45,
  provisional_start_time: false,
  started: true,
  team_a: 20,
  team_a_score: 0,
  team_h: 10,
  team_h_score: 1,
  stats: [
    {
      identifier: 'bps',
      h: [{ element: 101, value: bps }],
      a: [],
    },
  ],
  team_h_difficulty: 3,
  team_a_difficulty: 3,
  pulse_id: 401,
});

const referenceData = (): LiveSnapshotReferenceData => ({
  season: season.seasonCode,
  nameById: new Map([
    [10, 'Home FC'],
    [20, 'Away FC'],
  ]),
  shortNameById: new Map([
    [10, 'HOM'],
    [20, 'AWA'],
  ]),
  positionById: new Map(),
  playerTeamById: new Map([[101, 10]]),
  playerById: new Map([[101, { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }]]),
});

const eventLive = (): RawFPLEventLiveElement[] => {
  const source = structuredClone(rawExplainElementsFixture[0]);
  if (!source) throw new Error('event-live test fixture is missing');
  const explain = source.explain?.[0];
  if (!explain) throw new Error('event-live explain test fixture is missing');
  return [{ ...source, explain: [explain] }];
};

const emptyDetailEventLive = (): RawFPLEventLiveElement[] =>
  eventLive().map((element) => ({ ...element, explain: [] }));

async function clean(): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(
      cursor,
      'MATCH',
      `${prefix}*:${season.seasonCode}:${eventId}*`,
      'COUNT',
      200,
    );
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');
  keys.push(`${prefix}${season.seasonCode}:active-event`);
  if (keys.length > 0) await redis.del(...keys);
}

const enqueueCheckpoint = async (): Promise<void> => undefined;

describe('Live Matches V3 observation publication', () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await redis.quit();
  });

  test('derives freshness only from the shared lifecycle cadence', () => {
    const checkedAt = '2026-08-29T10:00:00.000Z';
    const cases = [
      [30, 75],
      [60, 180],
      [120, 300],
      [300, 720],
      [600, 1500],
      [900, 1800],
      [1800, 3600],
    ] as const;
    for (const [cadenceSeconds, budgetSeconds] of cases) {
      const expectedNextCheckAt = new Date(
        Date.parse(checkedAt) + cadenceSeconds * 1_000,
      ).toISOString();
      expect(
        liveMatchStaleAtForCadence('DAY_SETTLING', checkedAt, expectedNextCheckAt)?.toISOString(),
      ).toBe(new Date(Date.parse(checkedAt) + budgetSeconds * 1_000).toISOString());
    }
    expect(liveMatchStaleAtForCadence('FINALIZED', checkedAt, checkedAt)).toBeNull();
    expect(liveMatchStaleAtForCadence('LIVE_ACTIVE', checkedAt, null)).toBeNull();
  });

  test('advances the desk when event-live fails and keeps detail unavailable', async () => {
    const result = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(result.deskChanged).toBe(true);
    expect(result.detailChanged).toBe(false);
    expect(result.detail).toBeNull();
    expect(result.detailUnavailableReason).toBe('EVENT_LIVE_FETCH_FAILED');
    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.fixtures,
    ).toHaveLength(1);
    expect(await readLiveMatchDetailV3({ season: season.seasonCode, eventId, redis })).toBeNull();
  });

  test('rejects an older observation after the desk changes during its provider window', async () => {
    await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const observedDesk = await readLiveMatchDeskFenceV3({
      season: season.seasonCode,
      eventId,
      redis,
    });
    expect(observedDesk.read).not.toBeNull();

    await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), team_h_score: 2 }],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    await expect(
      syncLiveMatchesV3FromObservation({
        season,
        eventId,
        rawFixtures: [fixture(30)],
        referenceData: referenceData(),
        expectedFixtureIds: [401],
        observedAt: '2026-08-29T10:00:00.000Z',
        observedDesk,
        redis,
        enqueueCheckpoint,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PROMOTE_CHANGED' });
    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.fixtures[0],
    ).toMatchObject({ homeScore: 2 });
  });

  test('does not finalize a provisional desk after a newer desk wins', async () => {
    const provisional = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const observedActive = {
      observed: JSON.stringify(provisional.desk),
      read: {
        publication: provisional.desk,
        fixtures: provisional.deskFixtures,
        servedFrom: 'REDIS_CURRENT' as const,
      },
    };

    await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), team_h_score: 2 }],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    await expect(
      syncLiveMatchesV3FromObservation({
        season,
        eventId,
        rawFixtures: [fixture(30)],
        rawEventLive: { elements: eventLive() },
        referenceData: referenceData(),
        expectedFixtureIds: [401],
        finalizeEvent: true,
        lifecycleState: 'FINALIZED',
        observedAt: '2026-08-29T10:01:00.000Z',
        publishedDesk: {
          publication: provisional.desk,
          fixtures: provisional.deskFixtures,
          changed: provisional.deskChanged,
          checkpointScheduled: provisional.deskCheckpointScheduled,
          observedActive,
        },
        redis,
        enqueueCheckpoint,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_MATCH_PROMOTE_CHANGED' });

    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.publication.state,
    ).toBe('LIVE_ACTIVE');
    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.fixtures[0],
    ).toMatchObject({ homeScore: 2 });
  });

  test('reuses the fixture-phase desk without a second touch or checkpoint decision', async () => {
    const checkpointKinds: Array<'desk' | 'detail'> = [];
    const recordCheckpoint = async (
      _season: FplSeasonRef,
      _eventId: number,
      kind: 'desk' | 'detail',
    ): Promise<void> => {
      checkpointKinds.push(kind);
    };
    const early = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint: recordCheckpoint,
    });
    const complete = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      publishedDesk: {
        publication: early.desk,
        fixtures: early.deskFixtures,
        changed: early.deskChanged,
        checkpointScheduled: early.deskCheckpointScheduled,
        observedActive: {
          observed: JSON.stringify(early.desk),
          read: {
            publication: early.desk,
            fixtures: early.deskFixtures,
            servedFrom: 'REDIS_CURRENT',
          },
        },
      },
      redis,
      enqueueCheckpoint: recordCheckpoint,
    });

    expect(complete.desk.publicationId).toBe(early.desk.publicationId);
    expect(complete.desk.generation).toBe(early.desk.generation);
    expect(complete.desk.sourceCheckedAt).toBe('2026-08-29T10:00:00.000Z');
    expect(complete.detail).not.toBeNull();
    expect(checkpointKinds.filter((kind) => kind === 'desk')).toHaveLength(1);
    expect(checkpointKinds.filter((kind) => kind === 'detail')).toHaveLength(1);
  });

  test('rejects a first desk without an authoritative fixture identity set', async () => {
    await expect(
      syncLiveMatchesV3FromObservation({
        season,
        eventId,
        rawFixtures: [fixture(30)],
        referenceData: referenceData(),
        observedAt: '2026-08-29T10:00:00.000Z',
        redis,
        enqueueCheckpoint,
      }),
    ).rejects.toThrow('fixture identity authority is unavailable');
    expect(await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis })).toBeNull();
  });

  test('promotes changed score state and retains the previous complete desk', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const changedFixture = {
      ...fixture(30),
      team_h_score: 2,
      minutes: 60,
    } satisfies RawFPLFixture;

    const second = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [changedFixture],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(second.deskChanged).toBe(true);
    expect(second.desk.generation).toBeGreaterThan(first.desk.generation);
    expect(second.desk.revisions.scoreState.revision).not.toBe(
      first.desk.revisions.scoreState.revision,
    );
    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.fixtures[0],
    ).toMatchObject({ homeScore: 2, minutes: 60 });
    expect(
      await redis.get(liveMatchDeskKey({ season: season.seasonCode, eventId }, 'previous')),
    ).toContain(first.desk.publicationId);
  });

  test('uses a complete retained desk as identity authority and rejects partial fixtures', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const advanced = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), team_h_score: 2, minutes: 60 }],
      referenceData: null,
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });
    expect(advanced.desk.generation).toBeGreaterThan(first.desk.generation);

    await expect(
      syncLiveMatchesV3FromObservation({
        season,
        eventId,
        rawFixtures: [],
        referenceData: null,
        observedAt: '2026-08-29T10:01:00.000Z',
        redis,
        enqueueCheckpoint,
      }),
    ).rejects.toThrow('fixture identity mismatch');
    expect(
      (await readLiveMatchDeskV3({ season: season.seasonCode, eventId, redis }))?.publication
        .publicationId,
    ).toBe(advanced.desk.publicationId);
  });

  test('advances detail independently for a BPS-only change', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const firstDeskGeneration = first.desk.generation;
    const firstDetailGeneration = first.detail?.generation;

    const second = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(35)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(firstDetailGeneration).toBeDefined();
    expect(second.deskChanged).toBe(false);
    expect(second.desk.generation).toBe(firstDeskGeneration);
    expect(second.detailChanged).toBe(true);
    expect(second.detail?.generation).toBeGreaterThan(firstDetailGeneration ?? 0);
    const persistedDetail = await readLiveMatchDetailV3({
      season: season.seasonCode,
      eventId,
      redis,
    });
    expect(persistedDetail?.fixtures[0]?.players[0]?.stats).toEqual(
      expect.arrayContaining([{ identifier: 'bps', value: 35, awardedPoints: 0 }]),
    );
  });

  test('republishes unchanged detail when the desk generation advances', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const advanced = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), team_h_score: 2 }],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(advanced.desk.generation).toBeGreaterThan(first.desk.generation);
    expect(advanced.detailChanged).toBe(true);
    expect(advanced.detail?.generation).toBeGreaterThan(first.detail?.generation ?? 0);
    expect(advanced.detail?.observedDeskGeneration).toBe(advanced.desk.generation);
    expect(advanced.detail?.detail.revision).toBe(first.detail?.detail.revision);
  });

  test('rejects a stale detail-only observation captured before a newer detail wins', async () => {
    await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const observedDetail = await readLiveMatchDetailFenceV3({
      season: season.seasonCode,
      eventId,
      redis,
    });
    expect(observedDetail.read).not.toBeNull();

    const newer = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(35)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });
    const stale = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:15.000Z',
      observedDetail,
      redis,
      enqueueCheckpoint,
    });

    expect(stale.detailChanged).toBe(false);
    expect(stale.detail?.publicationId).toBe(newer.detail?.publicationId);
    expect(
      (await readLiveMatchDetailV3({ season: season.seasonCode, eventId, redis }))?.fixtures[0]
        ?.players[0]?.stats,
    ).toEqual(expect.arrayContaining([{ identifier: 'bps', value: 35, awardedPoints: 0 }]));
  });

  test('keeps compatible detail while a partial player roster only advances the desk', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const partialAuthority: LiveSnapshotReferenceData = {
      ...referenceData(),
      playerTeamById: new Map([
        [101, 10],
        [102, 20],
      ]),
      playerById: new Map([
        [101, { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }],
        [102, { id: 102, type: 2, teamId: 20, price: 60, webName: 'Player Two' }],
      ]),
    };
    const second = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), team_h_score: 2, minutes: 60 }],
      rawEventLive: { elements: eventLive() },
      referenceData: partialAuthority,
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(second.desk.generation).toBeGreaterThan(first.desk.generation);
    expect(second.detailChanged).toBe(false);
    expect(second.detail?.generation).toBe(first.detail?.generation);
    expect(second.detailUnavailableReason).toBe('DETAIL_CANDIDATE_INVALID');
  });

  test('keeps a complete finalized detail immutable across later identity observations', async () => {
    const finalFixture = {
      ...fixture(30),
      finished: true,
      finished_provisional: true,
      minutes: 90,
    } satisfies RawFPLFixture;
    const pinnedReference = (price: number, webName: string): LiveSnapshotReferenceData => ({
      ...referenceData(),
      eventPinnedIdentities: Promise.resolve([
        {
          fixtureId: 401,
          elementId: 101,
          teamId: 10,
          elementType: 3,
          price,
          webName,
        },
      ]),
    });
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [finalFixture],
      rawEventLive: { elements: eventLive() },
      referenceData: pinnedReference(50, 'Player One'),
      expectedFixtureIds: [401],
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      observedAt: '2026-08-29T10:01:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const second = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [finalFixture],
      rawEventLive: { elements: eventLive() },
      referenceData: pinnedReference(51, 'Player Renamed'),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:02:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const stored = await readLiveMatchDetailV3({ season: season.seasonCode, eventId, redis });

    expect(first.detail?.finalized).toBe(true);
    expect(second.detailChanged).toBe(false);
    expect(second.detail?.publicationId).toBe(first.detail?.publicationId);
    expect(second.detail?.generation).toBe(first.detail?.generation);
    expect(stored?.fixtures[0]?.players[0]).toMatchObject({
      id: 101,
      price: 50,
      webName: 'Player One',
    });
  });

  test('retains complete detail when provider explain and BPS evidence becomes empty', async () => {
    const first = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      rawEventLive: { elements: eventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const second = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), stats: [] }],
      rawEventLive: { elements: emptyDetailEventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:30.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(first.detail).not.toBeNull();
    expect(first.detail?.finalized).toBe(false);
    expect(second.detailChanged).toBe(false);
    expect(second.detail?.publicationId).toBe(first.detail?.publicationId);
    expect(second.detailUnavailableReason).toBe('DETAIL_EVIDENCE_INCOMPLETE');
    expect(
      (await readLiveMatchDetailV3({ season: season.seasonCode, eventId, redis }))?.fixtures[0]
        ?.players.length,
    ).toBeGreaterThan(0);

    const finalAttempt = await syncLiveMatchesV3FromObservation({
      season,
      eventId,
      rawFixtures: [{ ...fixture(30), finished: true, finished_provisional: true, stats: [] }],
      rawEventLive: { elements: emptyDetailEventLive() },
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      finalizeEvent: true,
      lifecycleState: 'FINALIZED',
      observedAt: '2026-08-29T10:01:00.000Z',
      redis,
      enqueueCheckpoint,
    });

    expect(finalAttempt.desk.state).toBe('FINALIZED');
    expect(finalAttempt.detail?.finalized).toBe(false);
    expect(finalAttempt.detailUnavailableReason).toBe('DETAIL_EVIDENCE_INCOMPLETE');
    expect(
      (await readLiveMatchDetailV3({ season: season.seasonCode, eventId, redis }))?.publication
        .finalized,
    ).toBe(false);
  });
});
