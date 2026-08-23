import { describe, expect, mock, test } from 'bun:test';

import type { DbTournamentGroup } from '../../src/db/schemas/index.schema';
import type { TournamentSyncContext } from '../../src/domain/tournament';
import {
  buildOfficialH2HRows,
  fetchOfficialH2HSourceSnapshot,
  projectOfficialH2HStandings,
  projectOfficialH2HStandingsFromMatches,
} from '../../src/services/tournament-official-h2h.service';

const tournament: TournamentSyncContext = {
  id: 7,
  leagueId: 34879,
  leagueType: 'h2h',
  rosterMode: 'official_sync',
  totalTeamNum: 11,
  groupMode: 'battle_races',
  groupStartedEventId: 1,
  groupEndedEventId: 35,
  groupQualifyNum: null,
  knockoutMode: 'head_to_head',
  knockoutTeamNum: 8,
  knockoutEventNum: 3,
  knockoutStartedEventId: 36,
  knockoutEndedEventId: 38,
  knockoutPlayAgainstNum: 1,
};

const singleEventTournament: TournamentSyncContext = {
  ...tournament,
  totalTeamNum: 3,
  groupEndedEventId: 1,
  knockoutMode: 'no_knockout',
  knockoutTeamNum: null,
  knockoutEventNum: null,
  knockoutStartedEventId: null,
  knockoutEndedEventId: null,
  knockoutPlayAgainstNum: null,
};

function group(entryId: number): DbTournamentGroup {
  const now = new Date('2026-08-13T00:00:00.000Z');
  return {
    id: entryId,
    sourceGroupRowId: entryId,
    tournamentId: 7,
    seasonId: 2026,
    groupId: 1,
    groupName: 'A',
    groupIndex: entryId,
    entryId,
    startedEventId: 1,
    endedEventId: 35,
    groupPoints: 0,
    groupRank: null,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    totalPoints: 0,
    totalTransfersCost: 0,
    totalNetPoints: 0,
    qualified: 0,
    overallRank: 100,
    createdAt: now,
    updatedAt: now,
  };
}

describe('official H2H source import', () => {
  test('ignores the official Average Team placeholder in standings', async () => {
    const getLeagueH2HStandings = mock(async () => ({
      standings: {
        has_next: false,
        results: [
          { entry: null, entry_name: 'AVERAGE', player_name: 'AVERAGE', rank: 1, total: 0 },
          { entry: 7819, entry_name: 'Real Team', player_name: 'Real Manager', rank: 1, total: 0 },
        ],
      },
      new_entries: { has_next: false, results: [] },
      league: { id: 34879, name: 'H2H' },
    }));
    const getLeagueH2HMatches = mock(async () => ({
      has_next: false,
      page: 1,
      results: [],
    }));

    const snapshot = await fetchOfficialH2HSourceSnapshot(34879, {
      getLeagueH2HStandings: getLeagueH2HStandings as never,
      getLeagueH2HMatches: getLeagueH2HMatches as never,
    });

    expect(snapshot.standings.map((standing) => standing.entry)).toEqual([7819]);
  });

  test('reads every match page and preserves the official absolute order', async () => {
    const getLeagueH2HStandings = mock(async () => ({
      standings: { has_next: false, results: [] },
      new_entries: { has_next: false, results: [] },
      league: { id: 34879, name: 'H2H' },
    }));
    const getLeagueH2HMatches = mock(async (_leagueId: number, page: number) => ({
      has_next: page === 1,
      page,
      results: [
        {
          id: page,
          event: 1,
          entry_1_entry: 1,
          entry_1_name: 'One',
          entry_1_player_name: 'Manager One',
          entry_1_points: null,
          entry_2_entry: 2,
          entry_2_name: 'Two',
          entry_2_player_name: 'Manager Two',
          entry_2_points: null,
          winner: null,
          is_bye: false,
          knockout_name: null,
          tiebreak: null,
        },
      ],
    }));

    const snapshot = await fetchOfficialH2HSourceSnapshot(34879, {
      getLeagueH2HStandings: getLeagueH2HStandings as never,
      getLeagueH2HMatches: getLeagueH2HMatches as never,
    });

    expect(snapshot.matches.map((match) => [match.id, match.sourceOrder])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  test('stores Average Team as a nullable side without creating a participant', () => {
    const rows = buildOfficialH2HRows(
      singleEventTournament,
      new Set([1, 2, 3]),
      {
        standings: [],
        matches: [
          {
            id: 9001,
            event: 1,
            entry_1_entry: 1,
            entry_1_name: 'One',
            entry_1_player_name: 'Manager One',
            entry_1_points: 42,
            entry_2_entry: null,
            entry_2_name: 'Average',
            entry_2_player_name: null,
            entry_2_points: 38,
            winner: 1,
            is_bye: false,
            knockout_name: null,
            tiebreak: null,
            sourceOrder: 0,
          },
          {
            id: 9002,
            event: 1,
            entry_1_entry: 2,
            entry_1_points: 40,
            entry_2_entry: 3,
            entry_2_points: 40,
            winner: null,
            is_bye: false,
            knockout_name: null,
            tiebreak: null,
            sourceOrder: 1,
          },
        ],
      },
      new Date('2026-08-13T01:00:00.000Z'),
    );

    expect(rows.battleRows).toHaveLength(2);
    expect(rows.battleRows.find((row) => row.officialMatchId === 9001)).toMatchObject({
      officialMatchId: 9001,
      sourceOrder: 0,
      homeEntryId: 1,
      awayEntryId: null,
      homeIsAverage: false,
      awayIsAverage: true,
      homeNetPoints: 42,
      awayNetPoints: 38,
      homeMatchPoints: 3,
      awayMatchPoints: 0,
    });

    const finalizedRows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2 },
      new Set([2, 3]),
      {
        standings: [],
        matches: [
          {
            id: 9002,
            event: 1,
            entry_1_entry: 2,
            entry_1_points: 40,
            entry_2_entry: 3,
            entry_2_points: 40,
            winner: null,
            is_bye: false,
            knockout_name: null,
            tiebreak: null,
            sourceOrder: 0,
          },
        ],
      },
      new Date('2026-08-13T01:00:00.000Z'),
      { finalizedThroughEventId: 1 },
    );

    expect(finalizedRows.battleRows[0]).toMatchObject({
      homeMatchPoints: 1,
      awayMatchPoints: 1,
    });
  });

  test('rejects a partial regular schedule before publishing or locking it', () => {
    expect(() =>
      buildOfficialH2HRows(
        singleEventTournament,
        new Set([1, 2, 3]),
        {
          standings: [],
          matches: [
            {
              id: 9010,
              event: 1,
              entry_1_entry: 1,
              entry_1_points: null,
              entry_2_entry: 2,
              entry_2_points: null,
              winner: null,
              knockout_name: null,
              sourceOrder: 0,
            },
          ],
        },
        new Date('2026-08-13T01:00:00.000Z'),
      ),
    ).toThrow('GW1 has 1 of 2 matches');
  });

  test('does not turn an official scheduled 0-0 placeholder into a draw', () => {
    const rows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2 },
      new Set([1, 2]),
      {
        standings: [],
        matches: [
          {
            id: 9050,
            event: 1,
            entry_1_entry: 1,
            entry_1_points: 0,
            entry_1_win: 0,
            entry_1_draw: 0,
            entry_1_loss: 0,
            entry_1_total: 0,
            entry_2_entry: 2,
            entry_2_points: 0,
            entry_2_win: 0,
            entry_2_draw: 0,
            entry_2_loss: 0,
            entry_2_total: 0,
            winner: null,
            knockout_name: null,
            sourceOrder: 0,
          },
        ],
      },
      new Date('2026-08-13T01:00:00.000Z'),
    );

    expect(rows.battleRows[0]).toMatchObject({
      homeNetPoints: 0,
      awayNetPoints: 0,
      homeMatchPoints: null,
      awayMatchPoints: null,
    });
  });

  test('derives a published outcome only after finalized-event evidence', () => {
    const snapshot = {
      standings: [],
      matches: [
        {
          id: 9060,
          event: 1,
          entry_1_entry: 1,
          entry_1_points: 24,
          entry_1_win: 0,
          entry_1_draw: 0,
          entry_1_loss: 0,
          entry_1_total: 0,
          entry_2_entry: 2,
          entry_2_points: 43,
          entry_2_win: 0,
          entry_2_draw: 0,
          entry_2_loss: 0,
          entry_2_total: 0,
          winner: null,
          is_bye: false,
          knockout_name: null,
          sourceOrder: 0,
        },
      ],
    };
    const unfinalizedRows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2 },
      new Set([1, 2]),
      snapshot,
      new Date('2026-08-13T01:00:00.000Z'),
    );
    expect(unfinalizedRows.battleRows[0]).toMatchObject({
      homeMatchPoints: null,
      awayMatchPoints: null,
    });

    const rows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2 },
      new Set([1, 2]),
      snapshot,
      new Date('2026-08-13T01:00:00.000Z'),
      { finalizedThroughEventId: 1 },
    );

    expect(rows.battleRows[0]).toMatchObject({
      homeMatchPoints: 0,
      awayMatchPoints: 3,
    });
  });

  test('projects standings from official match scores when the upstream table is still zeroed', () => {
    const match = {
      id: 9061,
      event: 1,
      entry_1_entry: 1,
      entry_1_points: 24,
      entry_1_win: 0,
      entry_1_draw: 0,
      entry_1_loss: 0,
      entry_1_total: 0,
      entry_2_entry: 2,
      entry_2_points: 43,
      entry_2_win: 0,
      entry_2_draw: 0,
      entry_2_loss: 0,
      entry_2_total: 0,
      winner: null,
      is_bye: false,
      knockout_name: null,
      sourceOrder: 0,
    };
    const unfinalized = projectOfficialH2HStandingsFromMatches(new Set([1, 2]), [match]);
    expect(unfinalized.every((standing) => standing.matches_played === 0)).toBe(true);

    const projected = projectOfficialH2HStandingsFromMatches(new Set([1, 2]), [match], {
      finalizedThroughEventId: 1,
    });

    expect(projected).toEqual([
      expect.objectContaining({
        entry: 2,
        rank: 1,
        total: 3,
        matches_played: 1,
        matches_won: 1,
        points_for: 43,
      }),
      expect.objectContaining({
        entry: 1,
        rank: 2,
        total: 0,
        matches_played: 1,
        matches_lost: 1,
        points_for: 24,
      }),
    ]);
  });

  test('keeps later live-event outcomes unset when reconciling a finalized event', () => {
    const matches = [
      {
        id: 9071,
        event: 1,
        entry_1_entry: 1,
        entry_1_points: 50,
        entry_1_win: 0,
        entry_1_draw: 0,
        entry_1_loss: 0,
        entry_1_total: 0,
        entry_2_entry: 2,
        entry_2_points: 40,
        entry_2_win: 0,
        entry_2_draw: 0,
        entry_2_loss: 0,
        entry_2_total: 0,
        winner: null,
        is_bye: false,
        knockout_name: null,
        tiebreak: null,
        sourceOrder: 0,
      },
      {
        id: 9072,
        event: 2,
        entry_1_entry: 1,
        entry_1_points: 12,
        entry_1_win: 0,
        entry_1_draw: 0,
        entry_1_loss: 0,
        entry_1_total: 0,
        entry_2_entry: 2,
        entry_2_points: 18,
        entry_2_win: 0,
        entry_2_draw: 0,
        entry_2_loss: 0,
        entry_2_total: 0,
        winner: null,
        is_bye: false,
        knockout_name: null,
        tiebreak: null,
        sourceOrder: 1,
      },
    ];
    const options = { finalizedThroughEventId: 1 };
    const rows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2, groupEndedEventId: 2 },
      new Set([1, 2]),
      { standings: [], matches },
      new Date('2026-08-13T01:00:00.000Z'),
      options,
    );

    expect(
      rows.battleRows.map((row) => [row.eventId, row.homeMatchPoints, row.awayMatchPoints]),
    ).toEqual([
      [1, 3, 0],
      [2, null, null],
    ]);
    expect(projectOfficialH2HStandingsFromMatches(new Set([1, 2]), matches, options)).toEqual([
      expect.objectContaining({ entry: 1, total: 3, matches_played: 1, points_for: 50 }),
      expect.objectContaining({ entry: 2, total: 0, matches_played: 1, points_for: 40 }),
    ]);
  });

  test('keeps the locked schedule hash stable across scores and later knockout rows', () => {
    const knockoutTournament: TournamentSyncContext = {
      ...tournament,
      totalTeamNum: 2,
      groupEndedEventId: 1,
      knockoutTeamNum: 2,
      knockoutEventNum: 1,
      knockoutStartedEventId: 2,
      knockoutEndedEventId: 2,
    };
    const regular = {
      id: 9100,
      event: 1,
      entry_1_entry: 1,
      entry_1_points: null,
      entry_2_entry: 2,
      entry_2_points: null,
      winner: null,
      knockout_name: null,
      sourceOrder: 0,
    };
    const before = buildOfficialH2HRows(
      knockoutTournament,
      new Set([1, 2]),
      { standings: [], matches: [regular] },
      new Date('2026-08-13T01:00:00.000Z'),
    );
    const after = buildOfficialH2HRows(
      knockoutTournament,
      new Set([1, 2]),
      {
        standings: [],
        matches: [
          { ...regular, entry_1_points: 50, entry_2_points: 40, winner: 1 },
          {
            id: 9200,
            event: 2,
            entry_1_entry: 1,
            entry_1_points: 45,
            entry_2_entry: 2,
            entry_2_points: 45,
            winner: 2,
            is_knockout: true,
            knockout_name: 'Final',
            tiebreak: { goals: '2-1' },
            sourceOrder: 1,
          },
        ],
      },
      new Date('2026-08-13T02:00:00.000Z'),
    );

    expect(after.scheduleHash).toBe(before.scheduleHash);
    expect(after.knockoutRows).toHaveLength(1);
    expect(after.knockoutRows[0]).toMatchObject({
      officialMatchId: 9200,
      sourceOrder: 1,
      knockoutName: 'Final',
      matchWinner: 2,
    });
    expect(after.bracketRows).toHaveLength(1);
  });
});

describe('official H2H standings projector', () => {
  test('uses official match points, W/D/L, Points For, and shared ranks', () => {
    const projected = projectOfficialH2HStandings(
      [group(1), group(2)],
      [
        {
          entry: 1,
          rank: 1,
          total: 7,
          matches_played: 3,
          matches_won: 2,
          matches_drawn: 1,
          matches_lost: 0,
          points_for: 180,
        },
        {
          entry: 2,
          rank: 1,
          total: 7,
          matches_played: 3,
          matches_won: 2,
          matches_drawn: 1,
          matches_lost: 0,
          points_for: 180,
        },
      ],
    );

    expect(projected).toEqual([
      expect.objectContaining({
        entryId: 1,
        groupPoints: 7,
        groupRank: 1,
        played: 3,
        won: 2,
        drawn: 1,
        lost: 0,
        totalNetPoints: 180,
      }),
      expect.objectContaining({ entryId: 2, groupRank: 1, totalNetPoints: 180 }),
    ]);
  });

  test('preserves an official negative Points For value', () => {
    const projected = projectOfficialH2HStandings(
      [group(1)],
      [
        {
          entry: 1,
          rank: 1,
          total: 0,
          matches_played: 1,
          matches_won: 0,
          matches_drawn: 0,
          matches_lost: 1,
          points_for: -3,
        },
      ],
    );

    expect(projected[0]?.totalNetPoints).toBe(-3);
  });
});
