import { describe, expect, mock, test } from 'bun:test';

import type { DbTournamentGroup } from '../../src/db/schemas/index.schema';
import type { TournamentSyncContext } from '../../src/domain/tournament';
import {
  buildOfficialH2HRows,
  fetchOfficialH2HSourceSnapshot,
  hasCompleteOfficialH2HScoreBatch,
  hasCompleteEntryEventTotalsCoverage,
  isOfficialH2HGroupEvent,
  minimumOfficialPlayedCoverageForSuppressedEvent,
  projectOfficialH2HStandings,
  projectOfficialH2HStandingsFromMatches,
  projectOfficialH2HEventLiveScores,
  resolveFinalizedThroughEventId,
  resolveOfficialH2HSyncOptionsFromEventState,
  selectOfficialH2HStandings,
  suppressOfficialH2HActiveScores,
  validatedOfficialH2HSyncOptions,
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
  test('requires contiguous cumulative history before adding a provisional round', () => {
    expect(
      hasCompleteEntryEventTotalsCoverage({ eventCount: 2, firstEventId: 1, lastEventId: 2 }, 1, 2),
    ).toBe(true);
    expect(
      hasCompleteEntryEventTotalsCoverage({ eventCount: 1, firstEventId: 1, lastEventId: 2 }, 1, 2),
    ).toBe(false);
    expect(hasCompleteEntryEventTotalsCoverage(undefined, 1, 2)).toBe(false);
    expect(hasCompleteEntryEventTotalsCoverage(undefined, 1, 0)).toBe(true);
  });

  test('adds provisional cumulative totals only inside the configured group window', () => {
    expect(isOfficialH2HGroupEvent(tournament, 1)).toBe(true);
    expect(isOfficialH2HGroupEvent(tournament, 35)).toBe(true);
    expect(isOfficialH2HGroupEvent(tournament, 36)).toBe(false);
  });

  test('uses event-live manager scores instead of a lagging official H2H score', () => {
    const snapshot = {
      standings: [],
      matches: [
        {
          id: 2071743,
          event: 1,
          entry_1_entry: 109967,
          entry_1_points: 23,
          entry_2_entry: 34299,
          entry_2_points: 17,
          winner: 109967,
          knockout_name: null,
          sourceOrder: 0,
        },
      ],
    };
    const projected = projectOfficialH2HEventLiveScores(snapshot, 1, new Set([109967, 34299]), {
      season: '2627',
      eventId: 1,
      state: 'live',
      revision: 'fpl:live:publication-8:8',
      publicationId: 'publication-8',
      liveRevision: '8',
      checkedAt: '2026-08-24T00:01:00.000Z',
      sourceCheckedAt: '2026-08-24T00:00:59.000Z',
      calculationMode: 'PROJECTED_AUTOSUBS',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      scores: new Map([
        [
          109967,
          {
            entryId: 109967,
            eventPoints: 37,
            netEventPoints: 37,
            transferCost: 0,
            totalPoints: 37,
            picksCheckedAt: '2026-08-24T00:00:30.000Z',
            revision: 'score-109967',
          },
        ],
        [
          34299,
          {
            entryId: 34299,
            eventPoints: 31,
            netEventPoints: 31,
            transferCost: 0,
            totalPoints: 31,
            picksCheckedAt: '2026-08-24T00:00:30.000Z',
            revision: 'score-34299',
          },
        ],
      ]),
    });

    expect(projected?.matches[0]).toMatchObject({
      entry_1_points: 37,
      entry_2_points: 31,
      winner: 109967,
    });
  });

  test('rejects a complete all-zero event-live placeholder batch', () => {
    const checkedAt = '2026-08-24T00:01:00.000Z';
    expect(
      projectOfficialH2HEventLiveScores(
        {
          standings: [],
          matches: [
            {
              id: 2071743,
              event: 1,
              entry_1_entry: 109967,
              entry_1_points: 23,
              entry_2_entry: 34299,
              entry_2_points: 17,
              winner: 109967,
              knockout_name: null,
              sourceOrder: 0,
            },
          ],
        },
        1,
        new Set([109967, 34299]),
        {
          season: '2627',
          eventId: 1,
          state: 'live',
          revision: 'fpl:live:publication-placeholder',
          publicationId: 'publication-placeholder',
          liveRevision: 'placeholder',
          checkedAt,
          sourceCheckedAt: checkedAt,
          calculationMode: 'PROJECTED_AUTOSUBS',
          algorithmVersion: 'fpl-projected-autosubs-v1',
          scores: new Map(
            [109967, 34299].map((entryId) => [
              entryId,
              {
                entryId,
                eventPoints: 0,
                netEventPoints: 0,
                transferCost: 0,
                totalPoints: 0,
                picksCheckedAt: checkedAt,
                revision: `score-${entryId}`,
              },
            ]),
          ),
        },
      ),
    ).toBeNull();
  });

  test('preserves a validated knockout tiebreak winner when event-live scores are level', () => {
    const snapshot = {
      standings: [],
      matches: [
        {
          id: 2071743,
          event: 1,
          entry_1_entry: 109967,
          entry_1_points: 23,
          entry_2_entry: 34299,
          entry_2_points: 23,
          winner: 34299,
          is_knockout: true,
          knockout_name: 'Final',
          tiebreak: { goals: '2-1' },
          sourceOrder: 0,
        },
      ],
    };
    const checkedAt = '2026-08-24T00:01:00.000Z';
    const projected = projectOfficialH2HEventLiveScores(snapshot, 1, new Set([109967, 34299]), {
      season: '2627',
      eventId: 1,
      state: 'live',
      revision: 'fpl:live:publication-8:8',
      publicationId: 'publication-8',
      liveRevision: '8',
      checkedAt,
      sourceCheckedAt: checkedAt,
      calculationMode: 'PROJECTED_AUTOSUBS',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      scores: new Map(
        [109967, 34299].map((entryId) => [
          entryId,
          {
            entryId,
            eventPoints: 37,
            netEventPoints: 37,
            transferCost: 0,
            totalPoints: 37,
            picksCheckedAt: checkedAt,
            revision: `score-${entryId}`,
          },
        ]),
      ),
    });

    expect(projected?.matches[0]).toMatchObject({
      entry_1_points: 37,
      entry_2_points: 37,
      winner: 34299,
    });
  });

  test('retains the freshly fetched FPL score for an Average Team side', () => {
    const checkedAt = '2026-08-24T00:01:00.000Z';
    const projected = projectOfficialH2HEventLiveScores(
      {
        standings: [],
        matches: [
          {
            id: 2071743,
            event: 1,
            entry_1_entry: 109967,
            entry_1_points: 23,
            entry_2_entry: null,
            entry_2_points: 31,
            winner: null,
            is_bye: false,
            knockout_name: null,
            sourceOrder: 0,
          },
        ],
      },
      1,
      new Set([109967]),
      {
        season: '2627',
        eventId: 1,
        state: 'live',
        revision: 'fpl:live:publication-8:8',
        publicationId: 'publication-8',
        liveRevision: '8',
        checkedAt,
        sourceCheckedAt: checkedAt,
        calculationMode: 'PROJECTED_AUTOSUBS',
        algorithmVersion: 'fpl-projected-autosubs-v1',
        scores: new Map([
          [
            109967,
            {
              entryId: 109967,
              eventPoints: 37,
              netEventPoints: 37,
              transferCost: 0,
              totalPoints: 37,
              picksCheckedAt: checkedAt,
              revision: 'score-109967',
            },
          ],
        ]),
      },
    );

    expect(projected?.matches[0]).toMatchObject({
      entry_1_points: 37,
      entry_2_points: 31,
      winner: 109967,
    });
  });

  test('fails closed when an Average Team provider score is absent', () => {
    const checkedAt = '2026-08-24T00:01:00.000Z';
    expect(
      projectOfficialH2HEventLiveScores(
        {
          standings: [],
          matches: [
            {
              id: 2071743,
              event: 1,
              entry_1_entry: 109967,
              entry_1_points: 23,
              entry_2_entry: null,
              entry_2_points: null,
              winner: null,
              is_bye: false,
              knockout_name: null,
              sourceOrder: 0,
            },
          ],
        },
        1,
        new Set([109967]),
        {
          season: '2627',
          eventId: 1,
          state: 'live',
          revision: 'fpl:live:publication-8:8',
          publicationId: 'publication-8',
          liveRevision: '8',
          checkedAt,
          sourceCheckedAt: checkedAt,
          calculationMode: 'PROJECTED_AUTOSUBS',
          algorithmVersion: 'fpl-projected-autosubs-v1',
          scores: new Map([
            [
              109967,
              {
                entryId: 109967,
                eventPoints: 37,
                netEventPoints: 37,
                transferCost: 0,
                totalPoints: 37,
                picksCheckedAt: checkedAt,
                revision: 'score-109967',
              },
            ],
          ]),
        },
      ),
    ).toBeNull();
  });

  test('suppresses active official H2H points when a coherent event-live batch is unavailable', () => {
    const snapshot = suppressOfficialH2HActiveScores(
      {
        standings: [],
        matches: [
          {
            id: 2071743,
            event: 1,
            entry_1_entry: 109967,
            entry_1_points: 23,
            entry_2_entry: 34299,
            entry_2_points: 17,
            winner: 109967,
            knockout_name: null,
            sourceOrder: 0,
          },
        ],
      },
      1,
    );

    expect(snapshot.matches[0]).toMatchObject({
      entry_1_points: null,
      entry_2_points: null,
      winner: null,
    });
  });

  test('keeps a just-finalized requested event inside a lagging aggregate cutoff', () => {
    expect(resolveFinalizedThroughEventId(null, 1, true)).toBe(1);
    expect(resolveFinalizedThroughEventId(3, 4, true)).toBe(4);
    expect(resolveFinalizedThroughEventId(4, 4, false)).toBe(4);
    expect(resolveFinalizedThroughEventId(null, 1, false)).toBeNull();
  });

  test('does not mark an event provisional when either concurrent read has finalized it', () => {
    expect(
      resolveOfficialH2HSyncOptionsFromEventState(
        4,
        { finished: true, dataChecked: true, isCurrent: true },
        { id: 4 },
        { id: 3 },
      ),
    ).toEqual({ finalizedThroughEventId: 4, provisionalEventId: null });
    expect(
      resolveOfficialH2HSyncOptionsFromEventState(
        4,
        { finished: false, dataChecked: false, isCurrent: true },
        { id: 4 },
        { id: 4 },
      ),
    ).toEqual({ finalizedThroughEventId: 4, provisionalEventId: null });
    expect(
      resolveOfficialH2HSyncOptionsFromEventState(
        4,
        { finished: false, dataChecked: false, isCurrent: true },
        { id: 4 },
        { id: 3 },
      ),
    ).toEqual({ finalizedThroughEventId: 3, provisionalEventId: 4 });
  });

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

    const finalizedRows = buildOfficialH2HRows(
      { ...singleEventTournament, totalTeamNum: 2 },
      new Set([1, 2]),
      {
        standings: [],
        matches: rows.battleRows.map(() => ({
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
        })),
      },
      new Date('2026-08-13T01:01:00.000Z'),
      { finalizedThroughEventId: 1 },
    );
    expect(finalizedRows.battleRows[0]).toMatchObject({
      homeMatchPoints: 1,
      awayMatchPoints: 1,
    });
  });

  test('derives a published outcome only after finalized or validated-live evidence', () => {
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

  test('uses the newest validated live scores instead of stale explicit outcome fields', () => {
    const matches = [
      {
        id: 9062,
        event: 1,
        entry_1_entry: 1,
        entry_1_points: 20,
        entry_1_win: 1,
        entry_1_draw: 0,
        entry_1_loss: 0,
        entry_1_total: 3,
        entry_2_entry: 2,
        entry_2_points: 50,
        entry_2_win: 0,
        entry_2_draw: 0,
        entry_2_loss: 1,
        entry_2_total: 0,
        winner: 1,
        is_bye: false,
        knockout_name: null,
        sourceOrder: 0,
      },
    ];
    const entries = new Set([1, 2]);
    const options = validatedOfficialH2HSyncOptions(entries, matches, {
      provisionalEventId: 1,
    });

    expect(options).toEqual({
      finalizedThroughEventId: null,
      provisionalEventId: 1,
      suppressedEventId: null,
    });
    expect(projectOfficialH2HStandingsFromMatches(entries, matches, options)).toEqual([
      expect.objectContaining({ entry: 2, total: 3, matches_won: 1, points_for: 50 }),
      expect.objectContaining({ entry: 1, total: 0, matches_lost: 1, points_for: 20 }),
    ]);
    expect(
      buildOfficialH2HRows(
        { ...singleEventTournament, totalTeamNum: 2 },
        entries,
        { standings: [], matches },
        new Date('2026-08-13T01:00:00.000Z'),
        options,
      ).battleRows[0],
    ).toMatchObject({ homeMatchPoints: 0, awayMatchPoints: 3 });

    const staleOfficial = [
      {
        entry: 1,
        rank: 1,
        total: 3,
        matches_played: 1,
        matches_won: 1,
        matches_drawn: 0,
        matches_lost: 0,
        points_for: 20,
      },
      {
        entry: 2,
        rank: 2,
        total: 0,
        matches_played: 1,
        matches_won: 0,
        matches_drawn: 0,
        matches_lost: 1,
        points_for: 50,
      },
    ];
    const corrected = projectOfficialH2HStandingsFromMatches(entries, matches, options);
    expect(selectOfficialH2HStandings(staleOfficial, corrected, undefined, true)).toMatchObject({
      standings: corrected,
      usedMatchDerivedStandings: true,
      officialPlayed: 2,
      derivedPlayed: 2,
    });
  });

  test('keeps score precedence when stale outcome fields survive event finalization', () => {
    const match = {
      id: 9063,
      event: 1,
      entry_1_entry: 1,
      entry_1_points: 20,
      entry_1_win: 1,
      entry_1_draw: 0,
      entry_1_loss: 0,
      entry_1_total: 3,
      entry_2_entry: 2,
      entry_2_points: 50,
      entry_2_win: 0,
      entry_2_draw: 0,
      entry_2_loss: 1,
      entry_2_total: 0,
      winner: 1,
      is_bye: false,
      knockout_name: null,
      sourceOrder: 0,
    };

    expect(
      projectOfficialH2HStandingsFromMatches(new Set([1, 2]), [match], {
        finalizedThroughEventId: 1,
      }),
    ).toEqual([
      expect.objectContaining({ entry: 2, total: 3, matches_won: 1, points_for: 50 }),
      expect.objectContaining({ entry: 1, total: 0, matches_lost: 1, points_for: 20 }),
    ]);
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

  test('activates a live score batch only after the complete roster is scoreable', () => {
    const completeMatches = [
      {
        id: 9070,
        event: 1,
        entry_1_entry: 1,
        entry_1_points: 49,
        entry_2_entry: 2,
        entry_2_points: 23,
        winner: null,
        is_bye: false,
        knockout_name: null,
        sourceOrder: 0,
      },
      {
        id: 9071,
        event: 1,
        entry_1_entry: 3,
        entry_1_points: 24,
        entry_2_entry: null,
        entry_2_points: 23,
        winner: null,
        is_bye: false,
        knockout_name: null,
        sourceOrder: 1,
      },
    ];
    const entries = new Set([1, 2, 3]);

    expect(hasCompleteOfficialH2HScoreBatch(entries, completeMatches, 1)).toBe(true);
    expect(
      validatedOfficialH2HSyncOptions(entries, completeMatches, { provisionalEventId: 1 }),
    ).toEqual({ finalizedThroughEventId: null, provisionalEventId: 1, suppressedEventId: null });
    expect(
      projectOfficialH2HStandingsFromMatches(entries, completeMatches, {
        provisionalEventId: 1,
      }).find((standing) => standing.entry === 3),
    ).toMatchObject({ matches_played: 1, matches_won: 1, total: 3, points_for: 24 });

    for (const incompleteMatches of [
      [],
      completeMatches.slice(0, 1),
      [{ ...completeMatches[0], entry_2_points: null }, completeMatches[1]],
      [completeMatches[0], { ...completeMatches[1], entry_1_entry: 2 }],
      completeMatches.map((match) => ({ ...match, entry_1_points: 0, entry_2_points: 0 })),
    ]) {
      expect(hasCompleteOfficialH2HScoreBatch(entries, incompleteMatches, 1)).toBe(false);
      expect(
        validatedOfficialH2HSyncOptions(entries, incompleteMatches, { provisionalEventId: 1 }),
      ).toEqual({ finalizedThroughEventId: null, provisionalEventId: null, suppressedEventId: 1 });
    }

    const partialExplicitBatch = [
      { ...completeMatches[0], winner: 1 },
      { ...completeMatches[1], entry_1_points: null },
    ];
    const suppressedOptions = validatedOfficialH2HSyncOptions(entries, partialExplicitBatch, {
      provisionalEventId: 1,
    });
    expect(
      projectOfficialH2HStandingsFromMatches(
        entries,
        partialExplicitBatch,
        suppressedOptions,
      ).every((standing) => standing.matches_played === 0),
    ).toBe(true);
  });

  test('accepts a true bye for coverage but never awards standings points for it', () => {
    const matches = [
      {
        id: 9080,
        event: 1,
        entry_1_entry: 1,
        entry_1_points: 30,
        entry_2_entry: 2,
        entry_2_points: 20,
        winner: null,
        is_bye: false,
        knockout_name: null,
        sourceOrder: 0,
      },
      {
        id: 9081,
        event: 1,
        entry_1_entry: 3,
        entry_1_points: null,
        entry_2_entry: null,
        entry_2_points: null,
        winner: null,
        is_bye: true,
        knockout_name: null,
        sourceOrder: 1,
      },
    ];
    const entries = new Set([1, 2, 3]);

    expect(hasCompleteOfficialH2HScoreBatch(entries, matches, 1)).toBe(true);
    const projected = projectOfficialH2HStandingsFromMatches(entries, matches, {
      provisionalEventId: 1,
    });
    expect(projected.find((standing) => standing.entry === 3)).toMatchObject({
      total: 0,
      matches_played: 0,
      points_for: 0,
    });
  });

  test('accumulates finalized history with the complete live round and excludes knockout rows', () => {
    const matches = [
      {
        id: 9090,
        event: 1,
        entry_1_entry: 1,
        entry_1_points: 40,
        entry_2_entry: 2,
        entry_2_points: 30,
        winner: null,
        knockout_name: null,
        sourceOrder: 0,
      },
      {
        id: 9091,
        event: 2,
        entry_1_entry: 1,
        entry_1_points: 20,
        entry_2_entry: 2,
        entry_2_points: 50,
        winner: null,
        knockout_name: null,
        sourceOrder: 1,
      },
      {
        id: 9092,
        event: 2,
        entry_1_entry: 1,
        entry_1_points: 99,
        entry_2_entry: 2,
        entry_2_points: 0,
        winner: 1,
        is_knockout: true,
        knockout_name: 'Final',
        sourceOrder: 2,
      },
    ];

    const projected = projectOfficialH2HStandingsFromMatches(new Set([1, 2]), matches, {
      finalizedThroughEventId: 1,
      provisionalEventId: 2,
    });

    expect(projected).toEqual([
      expect.objectContaining({
        entry: 2,
        rank: 1,
        total: 3,
        matches_played: 2,
        matches_won: 1,
        matches_lost: 1,
        points_for: 80,
      }),
      expect.objectContaining({
        entry: 1,
        rank: 2,
        total: 3,
        matches_played: 2,
        matches_won: 1,
        matches_lost: 1,
        points_for: 60,
      }),
    ]);
  });

  test('uses shared ranks for equal match points and Points For', () => {
    const projected = projectOfficialH2HStandingsFromMatches(
      new Set([1, 2, 3, 4]),
      [
        {
          id: 9093,
          event: 1,
          entry_1_entry: 1,
          entry_1_points: 42,
          entry_2_entry: 3,
          entry_2_points: 20,
          winner: null,
          knockout_name: null,
          sourceOrder: 0,
        },
        {
          id: 9094,
          event: 1,
          entry_1_entry: 2,
          entry_1_points: 42,
          entry_2_entry: 4,
          entry_2_points: 10,
          winner: null,
          knockout_name: null,
          sourceOrder: 1,
        },
      ],
      { provisionalEventId: 1 },
    );

    expect(projected.slice(0, 2)).toEqual([
      expect.objectContaining({ entry: 1, rank: 1, total: 3, points_for: 42 }),
      expect.objectContaining({ entry: 2, rank: 1, total: 3, points_for: 42 }),
    ]);
  });

  test('prefers match-derived standings only while official played coverage is behind', () => {
    const official = [
      { entry: 1, rank: 1, total: 3, matches_played: 1, points_for: 40 },
      { entry: 2, rank: 2, total: 0, matches_played: 1, points_for: 30 },
    ];
    const derivedAhead = [
      { entry: 1, rank: 2, total: 3, matches_played: 2, points_for: 60 },
      { entry: 2, rank: 1, total: 3, matches_played: 2, points_for: 80 },
    ];

    expect(selectOfficialH2HStandings(official, derivedAhead)).toMatchObject({
      standings: derivedAhead,
      usedMatchDerivedStandings: true,
      officialPlayed: 2,
      derivedPlayed: 4,
    });

    const derivedEqualCoverage = derivedAhead.map((standing) => ({
      ...standing,
      matches_played: 1,
    }));
    expect(selectOfficialH2HStandings(official, derivedEqualCoverage)).toMatchObject({
      standings: official,
      usedMatchDerivedStandings: false,
      officialPlayed: 2,
      derivedPlayed: 2,
    });
    expect(
      selectOfficialH2HStandings(official, derivedEqualCoverage, undefined, true),
    ).toMatchObject({
      standings: derivedEqualCoverage,
      usedMatchDerivedStandings: true,
      officialPlayed: 2,
      derivedPlayed: 2,
    });
    const rankOnlyDifferentOfficial = derivedEqualCoverage.map((standing) => ({
      ...standing,
      rank: standing.rank === 1 ? 2 : 1,
    }));
    expect(
      selectOfficialH2HStandings(rankOnlyDifferentOfficial, derivedEqualCoverage, undefined, true),
    ).toMatchObject({
      standings: rankOnlyDifferentOfficial,
      usedMatchDerivedStandings: false,
      officialPlayed: 2,
      derivedPlayed: 2,
    });

    const partiallyRefreshedOfficial = [
      { ...official[0]!, matches_played: 2 },
      { ...official[1]!, matches_played: 0 },
    ];
    expect(
      selectOfficialH2HStandings(partiallyRefreshedOfficial, derivedEqualCoverage),
    ).toMatchObject({
      standings: derivedEqualCoverage,
      usedMatchDerivedStandings: true,
      officialPlayed: 2,
      derivedPlayed: 2,
    });

    const partiallyAdvancedOfficial = [
      { ...official[0]!, matches_played: 2 },
      { ...official[1]!, matches_played: 1 },
    ];
    const suppressedCoverageFloor = minimumOfficialPlayedCoverageForSuppressedEvent(
      derivedEqualCoverage,
      [
        {
          id: 9095,
          event: 2,
          entry_1_entry: 1,
          entry_1_points: 10,
          entry_2_entry: 2,
          entry_2_points: null,
          winner: null,
          knockout_name: null,
        },
      ],
      2,
    );
    expect(suppressedCoverageFloor).toEqual(
      new Map([
        [1, 2],
        [2, 2],
      ]),
    );
    expect(
      selectOfficialH2HStandings(
        partiallyAdvancedOfficial,
        derivedEqualCoverage,
        suppressedCoverageFloor,
      ),
    ).toMatchObject({
      standings: derivedEqualCoverage,
      usedMatchDerivedStandings: true,
    });
    const fullyAdvancedOfficial = official.map((standing) => ({
      ...standing,
      matches_played: 2,
    }));
    expect(
      selectOfficialH2HStandings(
        fullyAdvancedOfficial,
        derivedEqualCoverage,
        suppressedCoverageFloor,
      ),
    ).toMatchObject({
      standings: fullyAdvancedOfficial,
      usedMatchDerivedStandings: false,
    });

    const officialAhead = official.map((standing) => ({ ...standing, matches_played: 3 }));
    expect(selectOfficialH2HStandings(officialAhead, derivedAhead)).toMatchObject({
      standings: officialAhead,
      usedMatchDerivedStandings: false,
      officialPlayed: 6,
      derivedPlayed: 4,
    });
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

describe('official H2H request budget', () => {
  test('keeps locked incremental fetches at least 60% below a full page scan', async () => {
    const totalPages = 35;
    const makeClient = () => {
      const standingsPages: number[] = [];
      const matchPages: number[] = [];
      return {
        calls: { standingsPages, matchPages },
        client: {
          getLeagueH2HStandings: async (_leagueId: number, page: number) => {
            standingsPages.push(page);
            return {
              standings: {
                has_next: false,
                results: [{ entry: 1 }],
              },
              new_entries: { has_next: false, results: [] },
              league: { id: 34879, name: 'H2H' },
            } as never;
          },
          getLeagueH2HMatches: async (_leagueId: number, page: number) => {
            matchPages.push(page);
            return {
              has_next: page < totalPages,
              page,
              results: [
                {
                  id: page,
                  event: Math.min(page, 38),
                  entry_1_entry: 1,
                  entry_1_points: 10,
                  entry_2_entry: null,
                  entry_2_points: null,
                  winner: 1,
                },
              ],
            } as never;
          },
        },
      };
    };

    const full = makeClient();
    const fullSnapshot = await fetchOfficialH2HSourceSnapshot(34879, full.client);
    const incremental = makeClient();
    const incrementalSnapshot = await fetchOfficialH2HSourceSnapshot(34879, incremental.client, {
      matchPages: [2, 17],
    });

    const fullRequestCount = full.calls.standingsPages.length + full.calls.matchPages.length;
    const incrementalRequestCount =
      incremental.calls.standingsPages.length + incremental.calls.matchPages.length;

    expect(fullSnapshot.matches).toHaveLength(totalPages);
    expect(incrementalSnapshot.matches.map((match) => match.id)).toEqual([2, 17]);
    expect(incremental.calls.matchPages).toEqual([2, 17]);
    expect(incrementalRequestCount).toBeLessThanOrEqual(fullRequestCount * 0.4);
  });
});
