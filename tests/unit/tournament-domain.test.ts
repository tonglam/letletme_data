import { describe, expect, test } from 'bun:test';

import {
  buildKnockoutRows,
  parseLeagueUrl,
  planTournamentStructure,
  seedBracketEntries,
  type TournamentConfig,
  type TournamentCreateInput,
  type TournamentParticipant,
} from '../../src/domain/tournament';
import { ValidationError } from '../../src/utils/errors';

const participants = (ids: number[]): TournamentParticipant[] =>
  ids.map((id, index) => ({
    id: String(id),
    team: `Team ${id}`,
    manager: `Manager ${id}`,
    overallRank: index + 1,
    totalPoints: 1000 - index,
  }));

describe('parseLeagueUrl', () => {
  test('parses classic league URLs', () => {
    expect(parseLeagueUrl('https://fantasy.premierleague.com/leagues/12345/standings/c')).toEqual({
      leagueId: 12345,
      leagueType: 'classic',
    });
  });

  test('parses h2h league URLs', () => {
    expect(parseLeagueUrl('https://fantasy.premierleague.com/leagues/99/standings/h')).toEqual({
      leagueId: 99,
      leagueType: 'h2h',
    });
  });

  test('rejects non-FPL hosts', () => {
    expect(() => parseLeagueUrl('https://example.com/leagues/1/standings/c')).toThrow(
      ValidationError,
    );
  });
});

describe('seedBracketEntries', () => {
  test('pairs highest seed against lowest', () => {
    expect(seedBracketEntries([1, 2, 3, 4], 4)).toEqual([
      { homeEntryId: 1, awayEntryId: 4 },
      { homeEntryId: 2, awayEntryId: 3 },
    ]);
  });

  test('pads missing entries with null', () => {
    expect(seedBracketEntries([10, 20], 4)).toEqual([
      { homeEntryId: 10, awayEntryId: null },
      { homeEntryId: 20, awayEntryId: null },
    ]);
  });
});

describe('buildKnockoutRows', () => {
  const tournament: TournamentConfig = {
    id: 7,
    totalTeamNum: 4,
    groupMode: 'no_group',
    groupNum: null,
    groupStartedEventId: null,
    groupEndedEventId: null,
    groupQualifyNum: null,
    knockoutMode: 'single_elimination',
    knockoutTeamNum: 4,
    knockoutEventNum: 2,
    knockoutStartedEventId: 30,
    knockoutEndedEventId: 31,
    knockoutPlayAgainstNum: 1,
  };

  test('builds round-one seeded matches and empty later rounds', () => {
    const seeded = seedBracketEntries([1, 2, 3, 4], 4);
    const { matches, results } = buildKnockoutRows(tournament, seeded);

    expect(matches).toHaveLength(3);
    expect(matches[0]).toMatchObject({
      tournament_id: 7,
      match_id: 1,
      round: 1,
      home_entry_id: 1,
      away_entry_id: 4,
      started_event_id: 30,
    });
    expect(matches[2]).toMatchObject({
      round: 2,
      home_entry_id: null,
      away_entry_id: null,
    });
    expect(results.length).toBeGreaterThan(0);
  });

  test('returns empty rows when knockout config is incomplete', () => {
    expect(buildKnockoutRows({ ...tournament, knockoutTeamNum: 0 }, null)).toEqual({
      matches: [],
      results: [],
    });
  });
});

describe('planTournamentStructure', () => {
  const basePayload: TournamentCreateInput = {
    tournamentName: 'Test Cup',
    adminId: '1',
    creator: 'admin',
    participantSource: 'custom',
    leagueUrl: 'https://fantasy.premierleague.com/leagues/1/standings/c',
    groupFormat: 'none',
    startGameweek: 'GW1',
    endGameweek: 'GW1',
    knockoutFormat: 'single',
    selectedParticipantIds: ['1', '2', '3', '4'],
  };

  test('plans a knockout-only tournament', () => {
    const plan = planTournamentStructure(basePayload, participants([1, 2, 3, 4]), 1, 'classic');

    expect(plan.leagueId).toBe(1);
    expect(plan.leagueType).toBe('classic');
    expect(plan.knockoutTeamNum).toBe(4);
    expect(plan.knockoutEventNum).toBe(2);
    expect(plan.knockoutStartedEventId).toBe(2);
  });

  test('rejects when admin is not a participant', () => {
    expect(() =>
      planTournamentStructure(
        { ...basePayload, adminId: '999' },
        participants([1, 2, 3, 4]),
        1,
        'classic',
      ),
    ).toThrow(ValidationError);
  });

  test('rejects knockout team counts that are not a power of two', () => {
    expect(() =>
      planTournamentStructure(basePayload, participants([1, 2, 3]), 1, 'classic'),
    ).toThrow(ValidationError);
  });
});
