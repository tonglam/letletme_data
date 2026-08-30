import { describe, expect, test } from 'bun:test';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import {
  prepareLiveMatchDesk,
  prepareLiveMatchDetail,
  type MatchDeskFixture,
} from '../../src/services/live-match-v2';
import type { LiveSnapshotReferenceData } from '../../src/services/live-coherent-fetch';
import type { RawFPLFixture } from '../../src/types';

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
    [101, { id: 101, type: 3, teamId: 10, webName: 'Player One' }],
    [102, { id: 102, type: 2, teamId: 30, webName: 'Player Two' }],
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
        teamH: 30,
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
    const elements = structuredClone(rawExplainElementsFixture).filter(
      (element) => element.id === 101,
    );
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
      totalPoints: 12,
      stats: expect.arrayContaining([
        { identifier: 'bps', value: 30, points: 0, pointsModification: null },
      ]),
    });
    expect(detail.fixtures[1]?.players[0]).toMatchObject({
      id: 101,
      totalPoints: 4,
      stats: expect.arrayContaining([
        { identifier: 'bps', value: 5, points: 0, pointsModification: null },
      ]),
    });
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
        rawElements: structuredClone(rawExplainElementsFixture).filter(
          (element) => element.id === 101,
        ),
        rawFixtures: fixtures,
        deskFixtures: desk.fixtures,
        referenceData: { ...referenceData(), playerById: new Map() },
        publishedLiveElementIds: [101],
      }),
    ).toThrow('missing player identity');
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
    const first = structuredClone(rawExplainElementsFixture[0]);
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
        rawElements: [first, structuredClone(first)],
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
    const elements = structuredClone(rawExplainElementsFixture);
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
});
