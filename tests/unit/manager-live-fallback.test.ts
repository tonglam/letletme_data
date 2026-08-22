import { describe, expect, test } from 'bun:test';

import {
  managerSummaryFetchBatches,
  planClassicManagerFallback,
} from '../../src/domain/manager-live-fallback';

describe('classic manager live fallback', () => {
  test('uses official entry summaries after standings pagination is exhausted', () => {
    expect(planClassicManagerFallback([97_001], true)).toEqual({
      foregroundSummaryEntryIds: [97_001],
      backgroundEntryIds: [97_001],
      continueStandings: false,
    });
  });

  test('continues bounded standings pagination before falling back to summaries', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], false)).toEqual({
      foregroundSummaryEntryIds: [],
      backgroundEntryIds: [1, 2, 3, 4, 5],
      continueStandings: true,
    });
  });

  test('bounds foreground summary requests while retaining all background work', () => {
    expect(planClassicManagerFallback([1, 2, 3, 4, 5], true)).toEqual({
      foregroundSummaryEntryIds: [1, 2, 3, 4],
      backgroundEntryIds: [1, 2, 3, 4, 5],
      continueStandings: false,
    });
  });

  test('caps concurrent entry-summary work while retaining every target', () => {
    const entryIds = Array.from({ length: 11 }, (_, index) => index + 1);

    const batches = managerSummaryFetchBatches(entryIds);

    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 3]);
    expect(batches.flat()).toEqual(entryIds);
  });
});
