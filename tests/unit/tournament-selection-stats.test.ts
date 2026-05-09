import { describe, expect, it } from 'bun:test';

import { aggregateTournamentSelectionStatsRows } from '../../src/services/tournament-selection-stats.service';

describe('aggregateTournamentSelectionStatsRows', () => {
  it('aggregates picks, captaincy, vice-captaincy, and transfers per tournament', () => {
    const rows = aggregateTournamentSelectionStatsRows({
      eventId: 35,
      tournamentEntries: [
        { tournamentId: 1, entryId: 100 },
        { tournamentId: 1, entryId: 101 },
        { tournamentId: 2, entryId: 101 },
      ],
      pickRows: [
        {
          entryId: 100,
          picks: [
            { element: 10, is_captain: true },
            { element: 11, is_vice_captain: true },
          ],
        },
        {
          entryId: 101,
          picks: [
            { element: 10, is_captain: false },
            { element: 12, is_vice_captain: true },
          ],
        },
      ],
      transferRows: [
        { entryId: 100, elementInId: 12, elementOutId: 13 },
        { entryId: 101, elementInId: 10, elementOutId: 11 },
      ],
    });

    const tournamentOneElementTen = rows.find(
      (row) => row.tournamentId === 1 && row.elementId === 10,
    );
    expect(tournamentOneElementTen).toMatchObject({
      eventId: 35,
      pickCount: 2,
      captainCount: 1,
      transferInCount: 1,
      totalEntries: 2,
    });

    const tournamentTwoElementTen = rows.find(
      (row) => row.tournamentId === 2 && row.elementId === 10,
    );
    expect(tournamentTwoElementTen).toMatchObject({
      pickCount: 1,
      captainCount: 0,
      transferInCount: 1,
      totalEntries: 1,
    });

    const tournamentOneElementEleven = rows.find(
      (row) => row.tournamentId === 1 && row.elementId === 11,
    );
    expect(tournamentOneElementEleven).toMatchObject({
      pickCount: 1,
      viceCaptainCount: 1,
      transferOutCount: 1,
    });
  });
});
