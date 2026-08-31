import { describe, expect, mock, test } from 'bun:test';

import { enqueueFinalLeagueResultsAfterLiveSync } from '../../src/services/live-data-cascade.service';
import type { Event } from '../../src/types';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('durable live snapshot result cascade', () => {
  test('enqueues a distinct final league correction after fresh live data is persisted', async () => {
    const enqueueLeagueEventResults = mock(async () => ({ id: 'league-final' }));

    const result = await enqueueFinalLeagueResultsAfterLiveSync(TEST_SEASON, 12, {
      getCurrentEvent: async () =>
        ({
          id: 12,
          finished: true,
          dataChecked: true,
          dataCheckedAt: new Date('2026-08-22T22:00:00.000Z'),
        }) as Event,
      findFixturesByEvent: async () => [],
      getPostMatchResultsSlot: () => 'final-10',
      enqueueLeagueEventResults,
    });

    expect(result).toEqual({ id: 'league-final' });
    expect(enqueueLeagueEventResults).toHaveBeenCalledWith(TEST_SEASON, 12, 'cascade', {
      jobId: 'league-event-results-e12-coordinator-live-final-10',
    });
  });

  test('does not enqueue a live-data final correction before data is checked', async () => {
    const enqueueLeagueEventResults = mock(async () => ({ id: 'unexpected' }));

    const result = await enqueueFinalLeagueResultsAfterLiveSync(TEST_SEASON, 12, {
      getCurrentEvent: async () =>
        ({
          id: 12,
          finished: true,
          dataChecked: true,
          dataCheckedAt: null,
        }) as Event,
      findFixturesByEvent: async () => [],
      getPostMatchResultsSlot: () => 'provisional-10',
      enqueueLeagueEventResults,
    });

    expect(result).toBeNull();
    expect(enqueueLeagueEventResults).not.toHaveBeenCalled();
  });
});
