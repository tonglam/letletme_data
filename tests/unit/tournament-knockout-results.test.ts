import { describe, expect, test } from 'bun:test';

import {
  applyCandidateKnockoutResults,
  calcEntryWinningNum,
  shouldDeferNextRoundResultRehome,
} from '../../src/services/tournament-knockout-results.service';
import { resolveKnockoutLegEntrants } from '../../src/services/tournament-structure.service';

describe('tournament knockout win counts', () => {
  test('preserves the configured home/away reversal for even legs', () => {
    expect(resolveKnockoutLegEntrants(101, 202, 1)).toEqual({
      homeEntryId: 101,
      awayEntryId: 202,
    });
    expect(resolveKnockoutLegEntrants(101, 202, 2)).toEqual({
      homeEntryId: 202,
      awayEntryId: 101,
    });
  });

  test('keeps persisted win counts integer when a leg is tied', () => {
    const results = [
      { homeEntryId: 101, awayEntryId: 202, homeNetPoints: 44, awayNetPoints: 31 },
      { homeEntryId: 202, awayEntryId: 101, homeNetPoints: 36, awayNetPoints: 36 },
    ];

    expect(calcEntryWinningNum(results, 101)).toBe(1);
    expect(calcEntryWinningNum(results, 202)).toBe(0);
  });

  test('scores structure-repair results against candidate entrants', () => {
    const persisted = [
      {
        sourceResultId: 7,
        tournamentId: 1,
        seasonId: 1,
        eventId: 34,
        matchId: 1,
        playAgainstId: 1,
        homeEntryId: 101,
        awayEntryId: 202,
      },
    ] as never[];
    const candidate = [
      {
        tournamentId: 1,
        eventId: 34,
        matchId: 1,
        playAgainstId: 1,
        homeEntryId: 303,
        awayEntryId: 404,
        sourceCheckedAt: null,
      },
    ] as never[];

    expect(applyCandidateKnockoutResults(persisted, candidate, 34)[0]).toMatchObject({
      sourceResultId: 7,
      homeEntryId: 303,
      awayEntryId: 404,
    });
  });

  test('keeps progressed later-round entrants when the candidate shell is unseeded', () => {
    const persisted = [
      {
        sourceResultId: 8,
        tournamentId: 1,
        seasonId: 1,
        eventId: 35,
        matchId: 2,
        playAgainstId: 1,
        homeEntryId: 303,
        awayEntryId: 404,
      },
    ] as never[];
    const candidate = [
      {
        tournamentId: 1,
        eventId: 35,
        matchId: 2,
        playAgainstId: 1,
        homeEntryId: null,
        awayEntryId: null,
        sourceCheckedAt: null,
      },
    ] as never[];

    expect(applyCandidateKnockoutResults(persisted, candidate, 35)[0]).toMatchObject({
      homeEntryId: 303,
      awayEntryId: 404,
    });
  });

  test('uses the repaired bracket seed for an unseeded later-round candidate', () => {
    const persisted = [
      {
        sourceResultId: 8,
        tournamentId: 1,
        seasonId: 1,
        eventId: 35,
        matchId: 2,
        playAgainstId: 1,
        homeEntryId: 101,
        awayEntryId: 202,
        homeNetPoints: 40,
        awayNetPoints: 30,
        sourceCheckedAt: new Date('2026-09-16T00:00:00.000Z'),
      },
    ] as never[];
    const candidate = [
      {
        tournamentId: 1,
        eventId: 35,
        matchId: 2,
        playAgainstId: 1,
        homeEntryId: null,
        awayEntryId: null,
        sourceCheckedAt: null,
      },
    ] as never[];

    expect(
      applyCandidateKnockoutResults(
        persisted,
        candidate,
        35,
        new Map([
          [
            2,
            {
              homeEntryId: 303,
              awayEntryId: 404,
            },
          ],
        ]),
      )[0],
    ).toMatchObject({
      homeEntryId: 303,
      awayEntryId: 404,
      homeNetPoints: 40,
      awayNetPoints: 30,
    });
  });

  test('swaps the repaired bracket seed for an even-leg candidate', () => {
    const persisted = [
      {
        sourceResultId: 8,
        tournamentId: 1,
        seasonId: 1,
        eventId: 36,
        matchId: 2,
        playAgainstId: 2,
        homeEntryId: 101,
        awayEntryId: 202,
      },
    ] as never[];
    const candidate = [
      {
        tournamentId: 1,
        eventId: 36,
        matchId: 2,
        playAgainstId: 2,
        homeEntryId: null,
        awayEntryId: null,
        sourceCheckedAt: null,
      },
    ] as never[];

    expect(
      applyCandidateKnockoutResults(
        persisted,
        candidate,
        36,
        new Map([
          [
            2,
            {
              homeEntryId: 303,
              awayEntryId: 404,
            },
          ],
        ]),
      )[0],
    ).toMatchObject({
      homeEntryId: 404,
      awayEntryId: 303,
    });
  });

  test('defers rehoming accepted next-round facts until replacement scores exist', () => {
    const accepted = [
      {
        homeEntryId: 101,
        awayEntryId: 202,
        homeNetPoints: 40,
        awayNetPoints: 30,
        homeGoalsScored: 1,
        homeGoalsConceded: 0,
        awayGoalsScored: 0,
        awayGoalsConceded: 1,
        matchWinner: 101,
        sourceCheckedAt: new Date('2026-09-16T00:00:00.000Z'),
      },
    ] as never[];

    expect(shouldDeferNextRoundResultRehome(accepted, 303, 404)).toBe(true);
    expect(shouldDeferNextRoundResultRehome(accepted, 101, 202)).toBe(false);
    expect(
      shouldDeferNextRoundResultRehome(
        [
          {
            homeEntryId: 101,
            awayEntryId: 202,
            homeNetPoints: null,
            awayNetPoints: null,
            homeGoalsScored: null,
            homeGoalsConceded: null,
            awayGoalsScored: null,
            awayGoalsConceded: null,
            matchWinner: null,
            sourceCheckedAt: null,
          },
        ] as never[],
        303,
        404,
      ),
    ).toBe(false);
  });

  test('drops persisted result rows outside the rebuilt candidate topology', () => {
    const persisted = [
      {
        sourceResultId: 9,
        tournamentId: 1,
        seasonId: 1,
        eventId: 36,
        matchId: 3,
        playAgainstId: 1,
        homeEntryId: 101,
        awayEntryId: 202,
      },
      {
        sourceResultId: 10,
        tournamentId: 1,
        seasonId: 1,
        eventId: 36,
        matchId: 3,
        playAgainstId: 2,
        homeEntryId: 999,
        awayEntryId: 888,
      },
    ] as never[];
    const candidate = [
      {
        tournamentId: 1,
        eventId: 36,
        matchId: 3,
        playAgainstId: 1,
        homeEntryId: 303,
        awayEntryId: 404,
        sourceCheckedAt: null,
      },
    ] as never[];

    expect(applyCandidateKnockoutResults(persisted, candidate, 36)).toMatchObject([
      { sourceResultId: 9, homeEntryId: 303, awayEntryId: 404 },
    ]);
  });
});
