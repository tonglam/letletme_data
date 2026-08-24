import { describe, expect, test } from 'bun:test';

import {
  UnderstatLeagueResponseSchema,
  UnderstatMatchResponseSchema,
  UnderstatTeamResponseSchema,
} from '../../src/clients/understat';
import { sourceYearFromSeason } from '../../src/domain/understat';
import {
  findUnderstatRosterAggregateDifferences,
  transformUnderstatMatchRoster,
  transformUnderstatPlayerDiscovery,
  transformUnderstatTeamDiscovery,
  transformUnderstatTeamParticipants,
  transformUnderstatTeamSplits,
  validateUnderstatTeamDates,
} from '../../src/transformers/understat';
import {
  UNDERSTAT_LEAGUE_FIXTURE,
  UNDERSTAT_MATCH_FIXTURE,
  UNDERSTAT_TEAM_FIXTURE,
} from '../fixtures/understat.fixtures';

describe('Understat transformers', () => {
  const league = UnderstatLeagueResponseSchema.parse(UNDERSTAT_LEAGUE_FIXTURE);
  const team = UnderstatTeamResponseSchema.parse(UNDERSTAT_TEAM_FIXTURE);
  const matchData = UnderstatMatchResponseSchema.parse(UNDERSTAT_MATCH_FIXTURE);
  const now = new Date('2026-08-21T20:00:00.000Z');

  test('converts canonical season to the Understat source year', () => {
    expect(sourceYearFromSeason('2627')).toBe(2026);
    expect(() => sourceYearFromSeason('2628')).toThrow('consecutive years');
  });

  test('strictly maps team history to match identity and aggregates both teams', () => {
    const result = transformUnderstatTeamDiscovery('2627', 2026, 'EPL', league, now);
    expect(result.matches[0].kickoffAt.toISOString()).toBe('2025-08-17T15:30:00.000Z');
    expect(result.teamMatchStats).toHaveLength(2);
    expect(result.teamSeasons.find((row) => row.teamId === 83)).toMatchObject({
      games: 1,
      wins: 1,
      goalsFor: 1,
      points: 3,
    });
  });

  test('keeps source hashes stable when only observation time changes', () => {
    const first = transformUnderstatTeamDiscovery('2627', 2026, 'EPL', league, now);
    const second = transformUnderstatTeamDiscovery(
      '2627',
      2026,
      'EPL',
      league,
      new Date('2026-08-22T20:00:00.000Z'),
    );
    expect(second.matches.map((row) => row.sourceHash)).toEqual(
      first.matches.map((row) => row.sourceHash),
    );
  });

  test('rejects history when score evidence cannot identify a unique match', () => {
    const invalid = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    invalid.teams['83'].history[0].scored = 2;
    expect(() =>
      transformUnderstatTeamDiscovery(
        '2627',
        2026,
        'EPL',
        UnderstatLeagueResponseSchema.parse(invalid),
        now,
      ),
    ).toThrow('did not map uniquely');
  });

  test('rejects a completed league match with only one team history row', () => {
    const invalid = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    invalid.teams['89'].history = [];
    expect(() =>
      transformUnderstatTeamDiscovery(
        '2627',
        2026,
        'EPL',
        UnderstatLeagueResponseSchema.parse(invalid),
        now,
      ),
    ).toThrow('does not contain exactly two team history rows');
  });

  test('allows active discovery to retain a partial completed-match history', () => {
    const partial = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    partial.teams['89'].history = [];
    const result = transformUnderstatTeamDiscovery(
      '2627',
      2026,
      'EPL',
      UnderstatLeagueResponseSchema.parse(partial),
      now,
      true,
    );
    expect(result.teamMatchStats.some((row) => row.teamId === 89)).toBe(false);
  });

  test('rejects duplicate team history identities even in active partial mode', () => {
    const invalid = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    invalid.teams['83'].history.push(structuredClone(invalid.teams['83'].history[0]));
    expect(() =>
      transformUnderstatTeamDiscovery(
        '2627',
        2026,
        'EPL',
        UnderstatLeagueResponseSchema.parse(invalid),
        now,
        true,
      ),
    ).toThrow('does not contain exactly two team history rows');
  });

  test('accepts an explicit UTC offset without appending another timezone', () => {
    const offset = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    offset.dates[0].datetime = '2025-08-17T15:30:00+00:00';
    offset.teams['89'].history[0].date = '2025-08-17T15:30:00+00:00';
    offset.teams['83'].history[0].date = '2025-08-17T15:30:00+00:00';
    const result = transformUnderstatTeamDiscovery(
      '2627',
      2026,
      'EPL',
      UnderstatLeagueResponseSchema.parse(offset),
      now,
    );
    expect(result.matches[0].kickoffAt.toISOString()).toBe('2025-08-17T15:30:00.000Z');
  });

  test('flattens all seven team split dimensions', () => {
    const matches = transformUnderstatTeamDiscovery('2627', 2026, 'EPL', league, now).matches;
    validateUnderstatTeamDates(team, 83, matches);
    const rows = transformUnderstatTeamSplits('2627', 83, team, new Set([28786]));
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.dimension)).size).toBe(7);
  });

  test('rejects a partial team page before replacing its season snapshot', () => {
    const partial = structuredClone(UNDERSTAT_TEAM_FIXTURE);
    partial.dates = [];
    const matches = transformUnderstatTeamDiscovery('2627', 2026, 'EPL', league, now).matches;
    expect(() =>
      validateUnderstatTeamDates(UnderstatTeamResponseSchema.parse(partial), 83, matches),
    ).toThrow('is missing league matches');
  });

  test('allows an active team page to omit a not-yet-available match', () => {
    const partial = structuredClone(UNDERSTAT_TEAM_FIXTURE);
    partial.dates = [];
    const matches = transformUnderstatTeamDiscovery('2627', 2026, 'EPL', league, now).matches;
    expect(() =>
      validateUnderstatTeamDates(UnderstatTeamResponseSchema.parse(partial), 83, matches, true),
    ).not.toThrow();
  });

  test('keeps team participants separate from league player aggregation', () => {
    const discovery = transformUnderstatPlayerDiscovery('2627', 2026, 'EPL', league, now);
    const participants = transformUnderstatTeamParticipants('2627', 83, team, new Set([28786]));
    expect(discovery.playerSeasons[0].sourceTeamTitle).toBe('Arsenal');
    expect(participants.playerTeamSeasons[0]).toMatchObject({ teamId: 83, playerId: 1001 });
  });

  test('never splits a transfer player team_title into provider relationships', () => {
    const transferLeague = structuredClone(UNDERSTAT_LEAGUE_FIXTURE);
    transferLeague.players[0].team_title = 'Crystal Palace, Arsenal';
    const transferTeam = structuredClone(UNDERSTAT_TEAM_FIXTURE);
    transferTeam.players[0].team_title = 'Crystal Palace, Arsenal';
    const discovery = transformUnderstatPlayerDiscovery(
      '2627',
      2026,
      'EPL',
      UnderstatLeagueResponseSchema.parse(transferLeague),
      now,
    );
    const participants = transformUnderstatTeamParticipants(
      '2627',
      83,
      UnderstatTeamResponseSchema.parse(transferTeam),
      new Set([28786]),
    );
    expect(discovery.playerSeasons[0].sourceTeamTitle).toBe('Crystal Palace, Arsenal');
    expect(participants.playerTeamSeasons).toEqual([
      expect.objectContaining({ playerId: 1001, teamId: 83 }),
    ]);
  });

  test('persists starter/substitute and roster link evidence without shots', () => {
    const match = transformUnderstatPlayerDiscovery('2627', 2026, 'EPL', league, now).matches[0];
    const result = transformUnderstatMatchRoster(match, matchData);
    expect(result.stats).toHaveLength(23);
    expect(result.stats.find((row) => row.rosterId === 7101)).toMatchObject({
      started: true,
      rosterInId: 7102,
    });
    expect(result.stats.find((row) => row.rosterId === 7102)).toMatchObject({
      started: false,
      rosterOutId: 7101,
    });
    expect(findUnderstatRosterAggregateDifferences(match, result.stats)).toContain(
      'h:xg expected=1.37653 roster=0.1',
    );
  });

  test('rejects a roster entry placed under the wrong side container', () => {
    const invalid = UnderstatMatchResponseSchema.parse(structuredClone(UNDERSTAT_MATCH_FIXTURE));
    invalid.rosters.h['7001'].h_a = 'a';
    invalid.rosters.h['7001'].team_id = 83;
    const match = transformUnderstatPlayerDiscovery('2627', 2026, 'EPL', league, now).matches[0];
    expect(() => transformUnderstatMatchRoster(match, invalid)).toThrow(
      'rosters.h contains side=a',
    );
  });
});
