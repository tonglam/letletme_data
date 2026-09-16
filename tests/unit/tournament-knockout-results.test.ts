import { describe, expect, test } from 'bun:test';

import {
  applyCandidateKnockoutResults,
  calcEntryWinningNum,
} from '../../src/services/tournament-knockout-results.service';

describe('tournament knockout win counts', () => {
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
