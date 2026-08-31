import { describe, expect, test } from 'bun:test';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import {
  prepareLiveMatchDesk,
  prepareLiveMatchDetail,
  type MatchDeskFixture,
} from '../../src/services/live-match-v2';
import {
  resolveLiveReferenceDataForDetail,
  type LiveSnapshotReferenceData,
} from '../../src/services/live-coherent-fetch';
import type {
  RawFPLEventExplainFixture,
  RawFPLEventLiveElement,
  RawFPLFixture,
} from '../../src/types';

const cloneRawElement = (element: RawFPLEventLiveElement): RawFPLEventLiveElement =>
  structuredClone(element) as RawFPLEventLiveElement;

const cloneRawElements = (): RawFPLEventLiveElement[] =>
  rawExplainElementsFixture.map(cloneRawElement);

const rawFixture = (input: {
  id: number;
  teamH: number;
  teamA: number;
  homeScore: number | null;
  awayScore: number | null;
  bpsElement: number;
  bps: number;
}): RawFPLFixture => ({
  code: input.id + 10_000,
  event: 2,
  finished: false,
  finished_provisional: false,
  id: input.id,
  kickoff_time: '2026-08-29T10:00:00.000Z',
  minutes: 90,
  provisional_start_time: false,
  started: true,
  team_a: input.teamA,
  team_a_score: input.awayScore,
  team_h: input.teamH,
  team_h_score: input.homeScore,
  stats: [
    {
      identifier: 'bps',
      h: [{ element: input.bpsElement, value: input.bps }],
      a: [],
    },
  ],
  team_h_difficulty: 3,
  team_a_difficulty: 3,
  pulse_id: input.id,
});

const referenceData = (): LiveSnapshotReferenceData => ({
  season: '2627',
  nameById: new Map([
    [10, 'Home FC'],
    [20, 'Away FC'],
    [30, 'Other FC'],
    [40, 'Visitor FC'],
  ]),
  shortNameById: new Map([
    [10, 'HOM'],
    [20, 'AWA'],
    [30, 'OTH'],
    [40, 'VIS'],
  ]),
  positionById: new Map(),
  playerTeamById: new Map([
    [101, 10],
    [102, 30],
  ]),
  playerById: new Map([
    [101, { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }],
    [102, { id: 102, type: 2, teamId: 30, price: 60, webName: 'Player Two' }],
  ]),
});

describe('Live Matches V2 fixture-grain preparation', () => {
  test('publishes compact desk identity/score without raw fixture stats', () => {
    const first = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: [
        rawFixture({
          id: 401,
          teamH: 10,
          teamA: 20,
          homeScore: 1,
          awayScore: 0,
          bpsElement: 101,
          bps: 30,
        }),
      ],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const second = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: [
        rawFixture({
          id: 401,
          teamH: 10,
          teamA: 20,
          homeScore: 1,
          awayScore: 0,
          bpsElement: 101,
          bps: 99,
        }),
      ],
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });

    expect(first.fixtures).toEqual(second.fixtures);
    expect(first.fixtures[0]).toMatchObject({
      fixtureId: 401,
      homeTeamName: 'Home FC',
      awayTeamShortName: 'AWA',
      homeScore: 1,
      awayScore: 0,
      started: true,
    });
  });

  test('keeps DGW explain points and BPS on their own fixture', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
      rawFixture({
        id: 402,
        teamH: 10,
        teamA: 40,
        homeScore: 0,
        awayScore: 0,
        bpsElement: 101,
        bps: 5,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401, 402],
    });
    const elements = cloneRawElements().filter((element) => element.id === 101);
    const detail = prepareLiveMatchDetail({
      eventId: 2,
      rawElements: elements,
      rawFixtures: fixtures,
      deskFixtures: desk.fixtures,
      referenceData: referenceData(),
      publishedLiveElementIds: [101],
    });

    expect(detail.fixtures).toHaveLength(2);
    expect(detail.fixtures[0]?.players[0]).toMatchObject({
      id: 101,
      price: 50,
      totalPoints: 12,
      stats: expect.arrayContaining([
        { identifier: 'bps', value: 30, points: 0, pointsModification: null },
      ]),
    });
    expect(detail.fixtures[1]?.players[0]).toMatchObject({
      id: 101,
      price: 50,
      totalPoints: 4,
      stats: expect.arrayContaining([
        { identifier: 'bps', value: 5, points: 0, pointsModification: null },
      ]),
    });
  });

  test('includes fixture point modifications in the displayed player total', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const originalElement = rawExplainElementsFixture[0];
    if (!originalElement?.explain?.[0]) throw new Error('event-live fixture is missing');
    const element = cloneRawElement(originalElement);
    const explain = element.explain as RawFPLEventExplainFixture[];
    const firstExplain = explain[0];
    if (!firstExplain) throw new Error('event-live fixture is missing');
    element.explain = [firstExplain];
    const bonus = firstExplain.stats.find((stat) => stat.identifier === 'bonus');
    if (!bonus) throw new Error('bonus fixture is missing');
    bonus.points_modification = null;

    const detail = prepareLiveMatchDetail({
      eventId: 2,
      rawElements: [element],
      rawFixtures: fixtures,
      deskFixtures: desk.fixtures,
      referenceData: {
        ...referenceData(),
        playerTeamById: new Map([[101, 10]]),
        playerById: new Map([
          [101, { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }],
        ]),
      },
    });

    expect(detail.fixtures[0]?.players[0]?.totalPoints).toBe(11);
  });

  test('uses fixture-time identity when a player has since transferred clubs', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const currentPlayer = {
      id: 101,
      type: 3,
      teamId: 30,
      price: 50,
      webName: 'Player One',
    } as const;
    const detail = prepareLiveMatchDetail({
      eventId: 2,
      rawElements: cloneRawElements()
        .filter((element) => element.id === 101)
        .map((element) => ({
          ...element,
          explain:
            (element.explain as RawFPLEventExplainFixture[] | null)?.filter(
              (fixture) => fixture.fixture === 401,
            ) ?? null,
        })),
      rawFixtures: fixtures,
      deskFixtures: desk.fixtures,
      referenceData: {
        ...referenceData(),
        playerById: new Map([[101, currentPlayer]]),
        playerByFixtureAndId: new Map([['401:101', { ...currentPlayer, teamId: 10 }]]),
      },
      publishedLiveElementIds: [101],
    });

    expect(detail.fixtures[0]?.players[0]).toMatchObject({ id: 101, teamId: 10 });
  });

  test('requires event-time identity for every visible fixture before finalizing detail', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
      rawFixture({
        id: 402,
        teamH: 10,
        teamA: 40,
        homeScore: 0,
        awayScore: 0,
        bpsElement: 101,
        bps: 5,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401, 402],
    });
    const baseReference = referenceData();

    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: cloneRawElements().filter((element) => element.id === 101),
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: {
          ...baseReference,
          playerTeamById: new Map([[101, 30]]),
          playerById: new Map([
            [101, { id: 101, type: 3, teamId: 30, price: 50, webName: 'Player One' }],
          ]),
          playerByFixtureAndId: new Map([
            ['401:101', { id: 101, type: 3, teamId: 10, price: 50, webName: 'Player One' }],
          ]),
        },
        publishedLiveElementIds: [101],
        requireEventPinnedIdentity: true,
      }),
    ).toThrow('missing event-time player identity for fixture 402 element 101');
  });

  test('fails closed when a visible transferred player has no fixture-time identity', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const baseReference = referenceData();

    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: cloneRawElements().filter((element) => element.id === 101),
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: {
          ...baseReference,
          playerById: new Map([
            [101, { id: 101, type: 3, teamId: 30, price: 50, webName: 'Player One' }],
          ]),
        },
        publishedLiveElementIds: [101],
      }),
    ).toThrow('no event-time team identity');
  });

  test('does not let pending event identity block the Core detail baseline', async () => {
    const reference = referenceData();
    const resolved = await Promise.race([
      resolveLiveReferenceDataForDetail({
        ...reference,
        eventPinnedIdentities: new Promise(() => undefined),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('event identity enrichment blocked detail')), 1_000),
      ),
    ]);

    if (!resolved) throw new Error('pending event identity unexpectedly returned no baseline');
    expect(resolved.playerById).toEqual(reference.playerById);
    expect(resolved.playerByFixtureAndId).toBeUndefined();
  });

  test('does not use the Core roster as the final identity fallback', async () => {
    const resolved = await resolveLiveReferenceDataForDetail(
      {
        ...referenceData(),
        eventPinnedIdentities: Promise.resolve(null),
      },
      { requireEventPinnedIdentity: true },
    );

    expect(resolved).toBeNull();
  });

  test('derives active and settled lifecycle from current fixtures on a stale job retry', () => {
    const playing = rawFixture({
      id: 401,
      teamH: 10,
      teamA: 20,
      homeScore: 1,
      awayScore: 0,
      bpsElement: 101,
      bps: 30,
    });
    expect(
      prepareLiveMatchDesk({
        eventId: 2,
        rawFixtures: [playing],
        referenceData: referenceData(),
        expectedFixtureIds: [401],
        lifecycleState: 'BETWEEN_FIXTURES',
      }).state,
    ).toBe('LIVE_ACTIVE');
    expect(
      prepareLiveMatchDesk({
        eventId: 2,
        rawFixtures: [{ ...playing, finished: true }],
        referenceData: referenceData(),
        expectedFixtureIds: [401],
        lifecycleState: 'LIVE_ACTIVE',
      }).state,
    ).toBe('DAY_SETTLING');
  });

  test('reuses previous team identity when Core is unavailable', () => {
    const previous: MatchDeskFixture = {
      fixtureId: 401,
      eventId: 2,
      homeTeamId: 10,
      homeTeamName: 'Home FC',
      homeTeamShortName: 'HOM',
      awayTeamId: 20,
      awayTeamName: 'Away FC',
      awayTeamShortName: 'AWA',
      homeScore: 0,
      awayScore: 0,
      kickoffTime: '2026-08-29T10:00:00.000Z',
      minutes: 0,
      started: false,
      finished: false,
      finishedProvisional: false,
    };
    const prepared = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: [
        rawFixture({
          id: 401,
          teamH: 10,
          teamA: 20,
          homeScore: 1,
          awayScore: 0,
          bpsElement: 101,
          bps: 30,
        }),
      ],
      referenceData: null,
      previousFixtures: [previous],
    });
    expect(prepared.fixtures[0]).toMatchObject({
      homeTeamName: 'Home FC',
      awayTeamName: 'Away FC',
    });
  });

  test('fails detail closed when player identity is missing', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 0,
        awayScore: 0,
        bpsElement: 999,
        bps: 5,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
    });
    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: cloneRawElements().filter((element) => element.id === 101),
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: { ...referenceData(), playerById: new Map() },
        publishedLiveElementIds: [101],
      }),
    ).toThrow('missing player identity');
  });

  test('ignores zero-valued transferred explain placeholders before fixture identity checks', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const visibleElement = cloneRawElement(rawExplainElementsFixture[0]!);
    visibleElement.explain = [(visibleElement.explain as RawFPLEventExplainFixture[])[0]!];
    const zeroElement = cloneRawElement(rawExplainElementsFixture[0]!);
    zeroElement.id = 103;
    zeroElement.stats.minutes = 0;
    zeroElement.stats.total_points = 0;
    zeroElement.explain = [
      {
        fixture: 401,
        stats: [{ identifier: 'minutes', value: 0, points: 0, points_modification: 0 }],
      },
    ];
    const baseReference = referenceData();
    const playerById = new Map(baseReference.playerById);
    playerById.set(103, {
      id: 103,
      type: 3,
      teamId: 30,
      price: 50,
      webName: 'Transferred Placeholder',
    });

    const detail = prepareLiveMatchDetail({
      eventId: 2,
      rawElements: [visibleElement, zeroElement],
      rawFixtures: fixtures,
      deskFixtures: desk.fixtures,
      referenceData: { ...baseReference, playerById },
      publishedLiveElementIds: [101, 103],
    });

    expect(detail.fixtures[0]?.players.map((player) => player.id)).toEqual([101]);
  });

  test('rejects partial and duplicate event-live player identity', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const originalElement = rawExplainElementsFixture[0];
    const first = originalElement ? cloneRawElement(originalElement) : undefined;
    if (!first) throw new Error('event-live fixture is missing');

    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: [first],
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: referenceData(),
      }),
    ).toThrow('Player identity mismatch');
    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: [first, cloneRawElement(first)],
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: referenceData(),
      }),
    ).toThrow('Duplicate player identity');
  });

  test('rejects an event-live element that cannot be transformed completely', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    const elements = cloneRawElements();
    const malformed = elements[0];
    if (!malformed) throw new Error('event-live fixture is missing');
    malformed.stats.minutes = -1;

    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: elements,
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: referenceData(),
      }),
    ).toThrow();
  });

  test('rejects a player identity with an invalid canonical price', () => {
    const fixtures = [
      rawFixture({
        id: 401,
        teamH: 10,
        teamA: 20,
        homeScore: 1,
        awayScore: 0,
        bpsElement: 101,
        bps: 30,
      }),
    ];
    const desk = prepareLiveMatchDesk({
      eventId: 2,
      rawFixtures: fixtures,
      referenceData: referenceData(),
      expectedFixtureIds: [401],
    });
    expect(() =>
      prepareLiveMatchDetail({
        eventId: 2,
        rawElements: cloneRawElements().filter((element) => element.id === 101),
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: {
          ...referenceData(),
          playerById: new Map([
            [101, { id: 101, type: 3, teamId: 10, price: -1, webName: 'Player One' }],
          ]),
        },
        publishedLiveElementIds: [101],
      }),
    ).toThrow('invalid player price');
  });
});
