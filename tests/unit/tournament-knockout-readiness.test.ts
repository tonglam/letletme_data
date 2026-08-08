import { describe, expect, mock, test } from 'bun:test';

import { loadFinalizedKnockoutLiveMap } from '../../src/services/tournament-knockout-results.service';
import { HISTORICAL_TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('tournament knockout live readiness', () => {
  test('requires finalized current-season coverage for every selected element', async () => {
    const readFinalized = mock(async () => [{ elementId: 101, goalsScored: 1, goalsConceded: 0 }]);

    await expect(
      loadFinalizedKnockoutLiveMap(38, HISTORICAL_TEST_SEASON, [101, 202], readFinalized),
    ).rejects.toThrow(
      'Finalized event live data is incomplete for knockout event 38; missing elements: 202',
    );
    expect(readFinalized).toHaveBeenCalledWith(38, HISTORICAL_TEST_SEASON);
  });
});
