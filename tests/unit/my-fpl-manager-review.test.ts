import { describe, expect, test } from 'bun:test';

import {
  buildMyFplManagerReview,
  type MyFplManagerReviewGameweekInput,
  type MyFplManagerReviewPickInput,
} from '../../src/domain/my-fpl-manager-review';

const positionTypes = [
  'GKP',
  'DEF',
  'DEF',
  'DEF',
  'DEF',
  'MID',
  'MID',
  'MID',
  'MID',
  'FWD',
  'FWD',
  'GKP',
  'DEF',
  'MID',
  'FWD',
] as const;

const points = [3, 1, 2, 4, 5, 6, 7, 8, 4, 9, 3, 8, 12, 10, 2] as const;

const picks = (withAutoSub: boolean): MyFplManagerReviewPickInput[] =>
  positionTypes.map((elementTypeName, index) => {
    const element = index + 1;
    const autoSubIn = withAutoSub && element === 13;
    const autoSubOut = withAutoSub && element === 2;
    const captain = element === 10;
    return {
      element,
      position: element,
      webName: `Player ${element}`,
      teamShortName: elementTypeName,
      elementTypeName,
      isCaptain: captain,
      isViceCaptain: element === 9,
      multiplier: autoSubOut ? 0 : captain ? 2 : element <= 11 || autoSubIn ? 1 : 0,
      totalPoints: points[index]!,
      isPlayed: !autoSubOut,
      autoSub: autoSubIn,
    };
  });

const gameweek = (
  eventId: number,
  overrides: Partial<MyFplManagerReviewGameweekInput> = {},
): MyFplManagerReviewGameweekInput => ({
  eventId,
  status: eventId === 2 ? 'PROVISIONAL' : 'FINAL',
  eventPoints: 72,
  eventRank: eventId * 100,
  overallPoints: eventId * 60,
  overallRank: eventId === 1 ? 1_000 : 800,
  eventTransfers: eventId === 2 ? 1 : 0,
  eventTransfersCost: eventId === 2 ? 4 : 0,
  eventNetPoints: eventId === 2 ? 56 : 50,
  eventBenchPoints: eventId === 2 ? 20 : 12,
  eventAutoSubPoints: eventId === 2 ? 12 : 0,
  eventChip: eventId === 2 ? 'WILDCARD' : 'NONE',
  eventCaptainPoints: 18,
  assistantManagerPoints: 0,
  captainBlank: false,
  playedCaptainElement: 10,
  playedCaptainWebName: 'Player 10',
  playedCaptainTeamShortName: 'FWD',
  teamValue: 1_000,
  bank: 10,
  picks: picks(eventId === 2),
  automaticSubstitutions: eventId === 2 ? [{ elementIn: 13, elementOut: 2 }] : [],
  ...overrides,
});

describe('My FPL manager review', () => {
  test('builds one coherent season review from finalized and provisional gameweeks', () => {
    const review = buildMyFplManagerReview(2, [gameweek(1), gameweek(2)]);

    expect(review.timeline).toHaveLength(2);
    expect(review.timeline[1]).toMatchObject({
      status: 'PROVISIONAL',
      overallRankDelta: null,
      eventAutoSubPoints: 12,
      review: {
        formation: '4-4-2',
        benchRegretPoints: null,
        captain: { regretPoints: null },
        automaticSubstitutions: [
          {
            elementIn: 13,
            elementInWebName: 'Player 13',
            elementOut: 2,
            elementOutWebName: 'Player 2',
            pointsGained: 12,
          },
        ],
      },
    });
    expect(review.timeline[0]!.review.bestElevenPoints).toBeGreaterThan(
      review.timeline[0]!.review.lineupBasePoints,
    );
    expect(review.summary).toMatchObject({
      gameweeksReviewed: 2,
      provisionalGameweeks: 1,
      totalNetPoints: 106,
      averageNetPoints: 53,
      medianNetPoints: 53,
      totalHitPoints: 4,
      hitGameweeks: 1,
      totalAutoSubPoints: 12,
      autoSubGameweeks: 1,
      overallRankChange: null,
      currentImprovementStreak: 0,
      longestImprovementStreak: 0,
    });
    expect(review.summary.chips).toEqual([
      expect.objectContaining({
        chip: 'WILDCARD',
        eventId: 2,
        status: 'PROVISIONAL',
        differenceFromOtherGameweeks: null,
      }),
    ]);
    expect(review.holdings.find((holding) => holding.element === 10)).toMatchObject({
      startedEventId: 1,
      endedEventId: null,
      gameweeksHeld: 2,
      starts: 2,
      captaincies: 2,
    });
  });

  test('does not label Bench Boost squad points as bench regret', () => {
    const benchBoost = gameweek(1, {
      eventChip: 'BENCH_BOOST',
      picks: picks(false).map((pick) => ({ ...pick, multiplier: pick.isCaptain ? 2 : 1 })),
    });
    const review = buildMyFplManagerReview(1, [benchBoost]);

    expect(review.timeline[0]?.review.benchRegretPoints).toBeNull();
    expect(review.timeline[0]?.review.formation).toBe('4-4-2');
    expect(review.holdings.find((holding) => holding.element === 12)?.starts).toBe(0);
    expect(review.holdings.find((holding) => holding.element === 13)?.starts).toBe(0);
  });

  test('keeps permanent holding periods continuous across a Free Hit', () => {
    const freeHitPicks = picks(false).map((pick) => ({
      ...pick,
      element: pick.element + 100,
      webName: `Free Hit ${pick.element}`,
    }));
    const review = buildMyFplManagerReview(3, [
      gameweek(1),
      gameweek(2, {
        status: 'FINAL',
        eventChip: 'FREE_HIT',
        picks: freeHitPicks,
        playedCaptainElement: 110,
        playedCaptainWebName: 'Free Hit 10',
      }),
      gameweek(3),
    ]);

    expect(review.holdings.find((holding) => holding.element === 1)).toMatchObject({
      startedEventId: 1,
      endedEventId: null,
      gameweeksHeld: 3,
      starts: 2,
    });
    expect(review.holdings.some((holding) => holding.element === 101)).toBe(false);
  });

  test('uses the intended captain multiplier when both captain choices fail', () => {
    const failedChoices = picks(false).map((pick) =>
      pick.isCaptain || pick.isViceCaptain ? { ...pick, multiplier: 0, totalPoints: 0 } : pick,
    );
    const review = buildMyFplManagerReview(1, [
      gameweek(1, {
        playedCaptainElement: null,
        playedCaptainWebName: null,
        playedCaptainTeamShortName: null,
        picks: failedChoices,
      }),
    ]);

    expect(review.timeline[0]?.review.captain.regretPoints).toBe(12);
  });

  test('normalizes unranked rows and keys captains by element id', () => {
    const first = gameweek(1, {
      overallRank: 0,
      eventRank: 0,
      playedCaptainElement: 10,
      playedCaptainWebName: 'Same name',
      picks: picks(false).map((pick) =>
        pick.element === 10 ? { ...pick, webName: 'Same name' } : pick,
      ),
    });
    const second = gameweek(2, {
      status: 'FINAL',
      overallRank: 800,
      playedCaptainElement: 9,
      playedCaptainWebName: 'Same name',
      picks: picks(false).map((pick) =>
        pick.element === 9
          ? { ...pick, isCaptain: true, isViceCaptain: false, webName: 'Same name' }
          : pick.element === 10
            ? { ...pick, isCaptain: false, isViceCaptain: true }
            : pick,
      ),
    });
    const review = buildMyFplManagerReview(2, [first, second]);

    expect(review.timeline[0]).toMatchObject({ overallRank: null, eventRank: null });
    expect(review.timeline[1]?.overallRankDelta).toBeNull();
    expect(review.summary.uniqueCaptains).toBe(2);
  });

  test('uses the effective short-handed lineup after auto-substitution', () => {
    const shortHanded = picks(false).map((pick) =>
      pick.element === 11 ? { ...pick, multiplier: 0 } : pick,
    );
    const review = buildMyFplManagerReview(1, [
      gameweek(1, { picks: shortHanded, eventBenchPoints: 3 }),
    ]);

    expect(review.timeline[0]?.review.lineupBasePoints).toBe(49);
  });

  test('keeps Assistant Manager points in the position breakdown and total', () => {
    const review = buildMyFplManagerReview(1, [
      gameweek(1, { eventChip: 'MANAGER', assistantManagerPoints: 7 }),
    ]);

    expect(review.timeline[0]?.review.assistantManagerPoints).toBe(7);
    expect(review.timeline[0]?.review.positionPoints.assistantManager).toBe(7);
    expect(review.timeline[0]?.review.positionPoints.total).toBe(
      review.timeline[0]!.review.positionPoints.goalkeeper +
        review.timeline[0]!.review.positionPoints.defender +
        review.timeline[0]!.review.positionPoints.midfielder +
        review.timeline[0]!.review.positionPoints.forward +
        7,
    );
    expect(review.summary.positionPoints.assistantManager).toBe(7);
  });
});
