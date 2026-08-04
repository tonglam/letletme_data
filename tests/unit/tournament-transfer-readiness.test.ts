import { describe, expect, test } from 'bun:test';

import { buildTournamentTransferPointsMap } from '../../src/services/tournament-event-transfers.service';

describe('tournament transfer enrichment readiness', () => {
  test('remains retryable until canonical event-live rows are available', () => {
    expect(() => buildTournamentTransferPointsMap(38, [])).toThrow(
      'Event live data is not consolidated for tournament transfer enrichment in event 38',
    );
  });

  test('builds the element points lookup from canonical rows', () => {
    expect(
      buildTournamentTransferPointsMap(12, [
        { elementId: 101, totalPoints: 7 },
        { elementId: 202, totalPoints: 3 },
      ]),
    ).toEqual(
      new Map([
        [101, 7],
        [202, 3],
      ]),
    );
  });
});
