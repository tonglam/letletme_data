import { describe, expect, test } from 'bun:test';

import { calcEntryWinningNum } from '../../src/services/tournament-knockout-results.service';

describe('tournament knockout win counts', () => {
  test('keeps persisted win counts integer when a leg is tied', () => {
    const results = [
      { homeEntryId: 101, awayEntryId: 202, homeNetPoints: 44, awayNetPoints: 31 },
      { homeEntryId: 202, awayEntryId: 101, homeNetPoints: 36, awayNetPoints: 36 },
    ];

    expect(calcEntryWinningNum(results, 101)).toBe(1);
    expect(calcEntryWinningNum(results, 202)).toBe(0);
  });
});
