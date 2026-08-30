import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import type { LiveSnapshotReferenceData } from '../../src/services/live-coherent-fetch';
import {
  liveMatchDeskKey,
  readLiveMatchDeskV2,
  readLiveMatchDetailV2,
} from '../../src/cache/live-match-publication-v2';
import {
  liveMatchStaleAtForCadence,
  syncLiveMatchesV2FromObservation,
} from '../../src/services/live-match-v2.service';
import type { RawFPLFixture, RawFPLEventLiveElement } from '../../src/types';

const redis = new Redis({ host: '127.0.0.1', port: 6379, db: 15 });
const season = { seasonId: 2026, seasonCode: '2627' } as const;
const eventId = 2;
const prefix = 'llm:data:v2:fpl:live-match:';

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
  playerById: new Map([[101, { id: 101, type: 3, teamId: 10, webName: 'Player One' }]]),
});

const eventLive = (): RawFPLEventLiveElement[] => {
  const source = structuredClone(rawExplainElementsFixture[0]);
  if (!source) throw new Error('event-live test fixture is missing');
  const explain = source.explain?.[0];
  if (!explain) throw new Error('event-live explain test fixture is missing');
  return [{ ...source, explain: [explain] }];
};

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

describe('Live Matches V2 observation publication', () => {
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
    const result = await syncLiveMatchesV2FromObservation({
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
      (await readLiveMatchDeskV2({ season: season.seasonCode, eventId, redis }))?.fixtures,
    ).toHaveLength(1);
    expect(await readLiveMatchDetailV2({ season: season.seasonCode, eventId, redis })).toBeNull();
  });

  test('rejects a first desk without an authoritative fixture identity set', async () => {
    await expect(
      syncLiveMatchesV2FromObservation({
        season,
        eventId,
        rawFixtures: [fixture(30)],
        referenceData: referenceData(),
        observedAt: '2026-08-29T10:00:00.000Z',
        redis,
        enqueueCheckpoint,
      }),
    ).rejects.toThrow('fixture identity authority is unavailable');
    expect(await readLiveMatchDeskV2({ season: season.seasonCode, eventId, redis })).toBeNull();
  });

  test('promotes changed score state and retains the previous complete desk', async () => {
    const first = await syncLiveMatchesV2FromObservation({
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

    const second = await syncLiveMatchesV2FromObservation({
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
      (await readLiveMatchDeskV2({ season: season.seasonCode, eventId, redis }))?.fixtures[0],
    ).toMatchObject({ homeScore: 2, minutes: 60 });
    expect(
      await redis.get(liveMatchDeskKey({ season: season.seasonCode, eventId }, 'previous')),
    ).toContain(first.desk.publicationId);
  });

  test('uses a complete retained desk as identity authority and rejects partial fixtures', async () => {
    const first = await syncLiveMatchesV2FromObservation({
      season,
      eventId,
      rawFixtures: [fixture(30)],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
      observedAt: '2026-08-29T10:00:00.000Z',
      redis,
      enqueueCheckpoint,
    });
    const advanced = await syncLiveMatchesV2FromObservation({
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
      syncLiveMatchesV2FromObservation({
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
      (await readLiveMatchDeskV2({ season: season.seasonCode, eventId, redis }))?.publication
        .publicationId,
    ).toBe(advanced.desk.publicationId);
  });

  test('advances detail independently for a BPS-only change', async () => {
    const first = await syncLiveMatchesV2FromObservation({
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

    const second = await syncLiveMatchesV2FromObservation({
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
    const persistedDetail = await readLiveMatchDetailV2({
      season: season.seasonCode,
      eventId,
      redis,
    });
    expect(persistedDetail?.fixtures[0]?.players[0]?.stats).toEqual(
      expect.arrayContaining([
        { identifier: 'bps', value: 35, points: 0, pointsModification: null },
      ]),
    );
  });

  test('keeps compatible detail while a partial player roster only advances the desk', async () => {
    const first = await syncLiveMatchesV2FromObservation({
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
        [101, { id: 101, type: 3, teamId: 10, webName: 'Player One' }],
        [102, { id: 102, type: 2, teamId: 20, webName: 'Player Two' }],
      ]),
    };
    const second = await syncLiveMatchesV2FromObservation({
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
});
