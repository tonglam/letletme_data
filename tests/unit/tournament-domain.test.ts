import { describe, expect, test } from 'bun:test';

import {
  buildKnockoutRows,
  estimateTournamentSetupRequests,
  getTournamentBackfillWindow,
  nextPowerOfTwo,
  parseLeagueUrl,
  planTournamentStructure,
  seedBracketEntries,
  tournamentCreateInputSchema,
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

  test('parses the localized classic standings URL copied from FPL', () => {
    expect(parseLeagueUrl('https://fantasy.premierleague.com/en/leagues/8863/standings/c')).toEqual(
      {
        leagueId: 8863,
        leagueType: 'classic',
      },
    );
  });

  test('parses h2h league URLs', () => {
    expect(parseLeagueUrl('https://fantasy.premierleague.com/leagues/99/standings/h')).toEqual({
      leagueId: 99,
      leagueType: 'h2h',
    });
  });

  test('parses the official new-entries H2H URL', () => {
    expect(
      parseLeagueUrl('https://fantasy.premierleague.com/en/leagues/34879/new-entries/h'),
    ).toEqual({ leagueId: 34879, leagueType: 'h2h' });
  });

  test('rejects non-FPL hosts', () => {
    expect(() => parseLeagueUrl('https://example.com/leagues/1/standings/c')).toThrow(
      ValidationError,
    );
  });

  test('rejects arbitrary path prefixes before leagues', () => {
    expect(() =>
      parseLeagueUrl('https://fantasy.premierleague.com/not-a-locale/leagues/1/standings/c'),
    ).toThrow(ValidationError);
  });

  test('rejects league IDs that cannot be represented safely', () => {
    expect(() =>
      parseLeagueUrl('https://fantasy.premierleague.com/leagues/9007199254740992/standings/c'),
    ).toThrow(ValidationError);
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

  test('uses first-round byes when the field is not a power of two', () => {
    expect(nextPowerOfTwo(93)).toBe(128);
    expect(seedBracketEntries([1, 2, 3, 4, 5, 6], 6)).toEqual([
      { homeEntryId: 1, awayEntryId: null },
      { homeEntryId: 4, awayEntryId: 5 },
      { homeEntryId: 2, awayEntryId: null },
      { homeEntryId: 3, awayEntryId: 6 },
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

  test('builds an integer bracket and preserves byes for a non-power-of-two field', () => {
    const sixTeamTournament: TournamentConfig = {
      ...tournament,
      knockoutTeamNum: 6,
      knockoutEventNum: 3,
      knockoutStartedEventId: 1,
      knockoutEndedEventId: 3,
    };
    const { matches, results } = buildKnockoutRows(
      sixTeamTournament,
      seedBracketEntries([1, 2, 3, 4, 5, 6], 6),
    );

    expect(matches).toHaveLength(7);
    expect(matches.filter((match) => match.round === 1)).toHaveLength(4);
    expect(results.filter((result) => result.event_id === 1)).toHaveLength(4);
    expect(
      results.filter((result) => result.event_id === 1 && result.away_entry_id === null),
    ).toHaveLength(2);
  });
});

describe('planTournamentStructure', () => {
  const basePayload: TournamentCreateInput = {
    tournamentName: 'Test Cup',
    adminId: '1',
    creator: 'admin',
    platformAdmin: false,
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
    expect(plan.knockoutStartedEventId).toBe(1);

    const withGroup = planTournamentStructure(
      {
        ...basePayload,
        groupFormat: 'points',
        endGameweek: 'GW5',
        groupNum: '1',
        qualifiersPerGroup: '4',
      },
      participants([1, 2, 3, 4]),
      1,
      'classic',
    );
    expect(withGroup.knockoutStartedEventId).toBe(6);
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

  test('allows a platform administrator outside the official participant set', () => {
    const plan = planTournamentStructure(
      { ...basePayload, adminId: '6953', platformAdmin: true },
      participants([1, 2, 3, 4]),
      1,
      'classic',
    );

    expect(plan.adminEntryId).toBe(6953);
    expect(plan.selectedParticipants.map((participant) => participant.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  test('accepts knockout team counts that are not a power of two with byes', () => {
    const plan = planTournamentStructure(basePayload, participants([1, 2, 3]), 1, 'classic');

    expect(plan.knockoutTeamNum).toBe(3);
    expect(plan.knockoutEventNum).toBe(2);
    expect(plan.knockoutEndedEventId).toBe(2);
  });

  test('enables official sync for an authoritative one-group Classic points race', () => {
    const eligible = planTournamentStructure(
      {
        ...basePayload,
        participantSource: 'official',
        groupFormat: 'points',
        groupNum: '1',
        endGameweek: 'GW38',
        knockoutFormat: 'none',
      },
      participants([1, 2, 3, 4]),
      1,
      'classic',
    );
    expect(eligible.rosterMode).toBe('official_sync');

    const ineligible = [{ participantSource: 'custom' as const }, { groupNum: '2' }];
    for (const variant of ineligible) {
      const plan = planTournamentStructure(
        {
          ...basePayload,
          participantSource: variant.participantSource ?? 'official',
          groupFormat: 'points',
          groupNum: variant.groupNum ?? '1',
          endGameweek: 'GW38',
          knockoutFormat: 'none',
        },
        participants([1, 2, 3, 4]),
        1,
        'classic',
      );
      expect(plan.rosterMode).toBe('snapshot');
    }
  });

  test('plans an official H2H mirror as one battle group with Average and FPL knockout rounds', () => {
    const plan = planTournamentStructure(
      {
        ...basePayload,
        participantSource: 'official',
        leagueUrl: 'https://fantasy.premierleague.com/leagues/34879/new-entries/h',
        groupFormat: 'points',
        groupNum: '1',
        endGameweek: 'GW38',
        knockoutFormat: 'none',
      },
      participants([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      34879,
      'h2h',
      'Official H2H',
      { startEventId: 1, knockoutRounds: 3 },
    );

    expect(plan).toMatchObject({
      leagueType: 'h2h',
      rosterMode: 'official_sync',
      groupMode: 'battle_races',
      groupNum: 1,
      groupAutoAverages: true,
      groupStartedEventId: 1,
      groupEndedEventId: 35,
      knockoutMode: 'head_to_head',
      knockoutTeamNum: 8,
      knockoutRounds: 3,
      knockoutStartedEventId: 36,
      knockoutEndedEventId: 38,
    });
  });
});

describe('tournament initialization window and request budget', () => {
  const tournament: TournamentConfig = {
    id: 7,
    totalTeamNum: 75,
    groupMode: 'points_races',
    groupNum: 1,
    groupStartedEventId: 1,
    groupEndedEventId: 38,
    groupQualifyNum: null,
    knockoutMode: 'no_knockout',
    knockoutTeamNum: null,
    knockoutEventNum: null,
    knockoutStartedEventId: null,
    knockoutEndedEventId: null,
    knockoutPlayAgainstNum: null,
  };

  test('stops baseline work at the latest finalized event and handles preseason/future starts', () => {
    expect(getTournamentBackfillWindow(tournament, 12)).toEqual({
      startEventId: 1,
      endEventId: 12,
    });
    expect(getTournamentBackfillWindow(tournament, null)).toBeNull();
    expect(getTournamentBackfillWindow({ ...tournament, groupStartedEventId: 20 }, 12)).toBeNull();
    expect(getTournamentBackfillWindow(tournament, 50)).toEqual({
      startEventId: 1,
      endEventId: 38,
    });
  });

  test('proves the 75-entry by 38-GW cold-start request gate', () => {
    expect(estimateTournamentSetupRequests(75, 38)).toEqual({
      unoptimizedColdStart: 5888,
      optimizedColdStartUpperBound: 3113,
      optimizedTransferHistoryRequests: 75,
      coreStandingsBaseline: 150,
    });
  });
});

describe('tournamentCreateInputSchema', () => {
  const validPayload = {
    tournamentName: 'Test Cup',
    adminId: '1',
    creator: 'admin',
    participantSource: 'custom' as const,
    tournamentType: 'standard' as const,
    leagueUrl: 'https://fantasy.premierleague.com/leagues/1/standings/c',
    groupFormat: 'points' as const,
    startGameweek: 'GW1',
    endGameweek: 'GW10',
    groupNum: '2',
    qualifiersPerGroup: '2',
    knockoutFormat: 'single' as const,
    selectedParticipantIds: ['1', '2', '3', '4'],
  };

  test('accepts a bounded tournament payload', () => {
    expect(tournamentCreateInputSchema.safeParse(validPayload).success).toBe(true);
  });

  test('rejects invalid numeric fields, insecure URLs, and reversed gameweeks', () => {
    const result = tournamentCreateInputSchema.safeParse({
      ...validPayload,
      leagueUrl: 'http://fantasy.premierleague.com/leagues/1/standings/c',
      startGameweek: 'GW12',
      endGameweek: 'GW4',
      groupNum: 'not-a-number',
      qualifiersPerGroup: '0',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(new Set(result.error.issues.map((issue) => issue.path[0]))).toEqual(
        new Set(['leagueUrl', 'endGameweek', 'groupNum', 'qualifiersPerGroup']),
      );
    }
  });
});
