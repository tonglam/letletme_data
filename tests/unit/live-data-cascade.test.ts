import { describe, expect, mock, test } from 'bun:test';

import {
  enqueueCascadeJobs,
  type CascadeEnqueueDeps,
} from '../../src/services/live-data-cascade.service';

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

  test('throws when any cascade enqueue fails so the parent job retries', async () => {
    const enqueueEventLiveSummary = createEnqueueMock();
    const enqueueEventLiveExplain = mock(async () => {
      throw new Error('redis down');
    }) as unknown as CascadeEnqueueDeps['enqueueEventLiveExplain'];
    const enqueueLiveFixtureCache = createEnqueueMock();
    const enqueueLiveBonusCache = createEnqueueMock();
    const enqueueEventOverallResult = createEnqueueMock();

    await expect(
      enqueueCascadeJobs(12, {
        isLiveMatchWindowForEvent: async () => false,
        enqueueEventLiveSummary,
        enqueueEventLiveExplain,
        enqueueLiveFixtureCache,
        enqueueLiveBonusCache,
        enqueueEventOverallResult,
      }),
    ).rejects.toThrow('Cascade enqueue failed for 1 of 3 jobs: explain');
  });

  test('names failed jobs correctly when the match window is open', async () => {
    const enqueueEventLiveSummary = createEnqueueMock();
    const enqueueEventLiveExplain = createEnqueueMock();
    const enqueueLiveFixtureCache = createEnqueueMock();
    const enqueueLiveBonusCache = mock(async () => {
      throw new Error('redis down');
    }) as unknown as CascadeEnqueueDeps['enqueueLiveBonusCache'];
    const enqueueEventOverallResult = createEnqueueMock();

    await expect(
      enqueueCascadeJobs(12, {
        isLiveMatchWindowForEvent: async () => true,
        enqueueEventLiveSummary,
        enqueueEventLiveExplain,
        enqueueLiveFixtureCache,
        enqueueLiveBonusCache,
        enqueueEventOverallResult,
      }),
    ).rejects.toThrow('live-bonus');
  });
});
