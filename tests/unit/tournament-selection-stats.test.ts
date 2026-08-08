import { describe, expect, it } from 'bun:test';

import {
  aggregateTournamentSelectionStatsRows,
  filterTournamentEntriesForEvent,
  hasCompleteTournamentPicks,
} from '../../src/services/tournament-selection-stats.service';

describe('aggregateTournamentSelectionStatsRows', () => {
  it('accepts exactly 15 unique valid picks as a complete source row', () => {
    const complete = Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    }));
    expect(hasCompleteTournamentPicks(complete)).toBe(true);
    expect(hasCompleteTournamentPicks(complete.slice(0, 14))).toBe(false);
    expect(hasCompleteTournamentPicks([...complete.slice(0, 14), { element: 1 }])).toBe(false);
    expect(hasCompleteTournamentPicks([...complete.slice(0, 14), {}])).toBe(false);
    expect(hasCompleteTournamentPicks([...complete.slice(0, 14), { element: 15.5 }])).toBe(false);
    const finalizedAutoSubPicks = complete.map((pick) => {
      if (pick.is_captain) return { ...pick, multiplier: 0 };
      if (pick.is_vice_captain) return { ...pick, multiplier: 2 };
      if (pick.position === 3) return { ...pick, multiplier: 0 };
      if (pick.position === 12) return { ...pick, multiplier: 1 };
      return pick;
    });
    expect(hasCompleteTournamentPicks(finalizedAutoSubPicks)).toBe(true);
    expect(
      hasCompleteTournamentPicks(
        complete.map((pick) => (pick.position === 12 ? { ...pick, multiplier: 2 } : pick)),
      ),
    ).toBe(false);
    expect(
      hasCompleteTournamentPicks([...complete.slice(0, 14), { ...complete[14], position: 14 }]),
    ).toBe(false);
  });

  it('excludes managers who had not entered yet from an event audit', () => {
    expect(
      filterTournamentEntriesForEvent(
        [
          { tournamentId: 1, entryId: 100 },
          { tournamentId: 1, entryId: 101 },
        ],
        new Map([
          [100, 1],
          [101, 20],
        ]),
        10,
      ),
    ).toEqual([{ tournamentId: 1, entryId: 100 }]);
  });

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
