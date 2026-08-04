import { describe, expect, mock, test } from 'bun:test';

import {
  buildTournamentTransferPointsMap,
  loadCanonicalTournamentTransferPointsMap,
} from '../../src/services/tournament-event-transfers.service';

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

  test('loads post-event points through the canonical row reader', async () => {
    const canonicalRead = mock(async () => [
      { elementId: 201, totalPoints: 7 },
      { elementId: 202, totalPoints: 3 },
    ]);

    const result = await loadCanonicalTournamentTransferPointsMap(12, canonicalRead);

    expect(result).toEqual(
      new Map([
        [201, 7],
        [202, 3],
      ]),
    );
    expect(canonicalRead).toHaveBeenCalledWith(12);
  });
});
