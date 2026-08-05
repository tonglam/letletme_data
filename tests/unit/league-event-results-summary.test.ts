import { describe, expect, test } from 'bun:test';

import { summarizeMissingLeagueEventLiveData } from '../../src/services/league-event-results.service';
import { inferDataSyncWorkSummary } from '../../src/utils/data-sync-attempt';

describe('league event results prerequisites', () => {
  test('reports every loaded entry as failed when event-live data is missing', () => {
    const summary = summarizeMissingLeagueEventLiveData(42, 7, 75);

    expect(summary).toEqual({
      tournamentId: 42,
      eventId: 7,
      totalEntries: 75,
      updated: 0,
      skipped: 75,
      errors: 75,
      requiredUnits: 75,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 75,
    });
    expect(inferDataSyncWorkSummary(summary)).toMatchObject({
      requiredUnits: 75,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 75,
    });
  });
});
