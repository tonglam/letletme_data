import { describe, expect, mock, test } from 'bun:test';

import {
  enqueueCascadeJobs,
  enqueueFinalLeagueResultsAfterLiveSync,
  type CascadeEnqueueDeps,
} from '../../src/services/live-data-cascade.service';
import type { Event } from '../../src/types';

function createEnqueueMock(): CascadeEnqueueDeps['enqueueEventLiveSummary'] {
  return mock(async () => ({
    id: 'job',
  })) as unknown as CascadeEnqueueDeps['enqueueEventLiveSummary'];
}

describe('event-lives-db cascade enqueue', () => {
  test('always enqueues summary, explain, and overall result', async () => {
    const enqueueEventLiveSummary = createEnqueueMock();
    const enqueueEventLiveExplain = createEnqueueMock();
    const enqueueLiveFixtureCache = createEnqueueMock();
    const enqueueLiveBonusCache = createEnqueueMock();
    const enqueueEventOverallResult = createEnqueueMock();

    const result = await enqueueCascadeJobs(12, {
      isLiveMatchWindowForEvent: async () => false,
      enqueueEventLiveSummary,
      enqueueEventLiveExplain,
      enqueueLiveFixtureCache,
      enqueueLiveBonusCache,
      enqueueEventOverallResult,
    });

    expect(result.jobNames).toEqual([
      'event-live-summary',
      'event-live-explain',
      'event-overall-result',
    ]);
    expect(enqueueEventLiveSummary).toHaveBeenCalledWith(12, 'cascade');
    expect(enqueueEventLiveExplain).toHaveBeenCalledWith(12, 'cascade');
    expect(enqueueEventOverallResult).toHaveBeenCalledWith(12, 'cascade');
    expect(enqueueLiveFixtureCache).not.toHaveBeenCalled();
    expect(enqueueLiveBonusCache).not.toHaveBeenCalled();
  });

  test('also enqueues live fixture and bonus when match window is open', async () => {
    const enqueueEventLiveSummary = createEnqueueMock();
    const enqueueEventLiveExplain = createEnqueueMock();
    const enqueueLiveFixtureCache = createEnqueueMock();
    const enqueueLiveBonusCache = createEnqueueMock();
    const enqueueEventOverallResult = createEnqueueMock();

    const result = await enqueueCascadeJobs(12, {
      isLiveMatchWindowForEvent: async () => true,
      enqueueEventLiveSummary,
      enqueueEventLiveExplain,
      enqueueLiveFixtureCache,
      enqueueLiveBonusCache,
      enqueueEventOverallResult,
    });

    expect(result.jobNames).toEqual([
      'event-live-summary',
      'event-live-explain',
      'live-fixture-cache',
      'live-bonus-cache',
      'event-overall-result',
    ]);
    expect(enqueueLiveFixtureCache).toHaveBeenCalledWith(12, 'cascade');
    expect(enqueueLiveBonusCache).toHaveBeenCalledWith(12, 'cascade');
  });

  test('enqueues a distinct final league correction after fresh live data is persisted', async () => {
    const enqueueLeagueEventResults = mock(async () => ({ id: 'league-final' }));

    const result = await enqueueFinalLeagueResultsAfterLiveSync(12, {
      getCurrentEvent: async () => ({ id: 12, dataChecked: true }) as Event,
      findFixturesByEvent: async () => [],
      getPostMatchResultsSlot: () => 'final-10',
      enqueueLeagueEventResults,
    });

    expect(result).toEqual({ id: 'league-final' });
    expect(enqueueLeagueEventResults).toHaveBeenCalledWith(12, 'cascade', {
      jobId: 'league-event-results-e12-coordinator-live-final-10',
    });
  });

  test('does not enqueue a live-data final correction before data is checked', async () => {
    const enqueueLeagueEventResults = mock(async () => ({ id: 'unexpected' }));

    const result = await enqueueFinalLeagueResultsAfterLiveSync(12, {
      getCurrentEvent: async () => ({ id: 12, dataChecked: false }) as Event,
      findFixturesByEvent: async () => [],
      getPostMatchResultsSlot: () => 'provisional-10',
      enqueueLeagueEventResults,
    });

    expect(result).toBeNull();
    expect(enqueueLeagueEventResults).not.toHaveBeenCalled();
  });
});
