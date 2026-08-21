import { describe, expect, test } from 'bun:test';

import type { TournamentStructurePlan } from '../../src/domain/tournament';
import { resolveTournamentEntrySeeds } from '../../src/repositories/tournament-infos';

const participant = (entryId: number) => ({
  id: String(entryId),
  team: `Team ${entryId}`,
  manager: `Manager ${entryId}`,
  overallRank: entryId,
  totalPoints: 0,
});

const plan = (adminEntryId: number): TournamentStructurePlan => ({
  leagueId: 1,
  leagueType: 'classic',
  tournamentName: 'Platform Cup',
  creator: 'Platform Admin',
  adminEntryId,
  selectedParticipants: [participant(1), participant(2)],
  groupMode: 'points_races',
  groupTeamNum: 2,
  groupNum: 1,
  groupAutoAverages: false,
  groupStartedEventId: 1,
  groupEndedEventId: 2,
  groupRounds: 2,
  groupQualifyNum: 1,
  knockoutMode: 'no_knockout',
  knockoutTeamNum: null,
  knockoutEventNum: null,
  knockoutRounds: null,
  knockoutStartedEventId: null,
  knockoutEndedEventId: null,
  knockoutPlayAgainstNum: null,
});

describe('tournament administrator entry persistence', () => {
  test('reuses an administrator already present in the selected roster', () => {
    expect(resolveTournamentEntrySeeds(plan(1)).map((entry) => entry.id)).toEqual(['1', '2']);
  });

  test('persists an out-of-roster administrator without adding tournament membership', () => {
    const input = plan(6953);
    input.administratorEntry = participant(6953);

    expect(resolveTournamentEntrySeeds(input).map((entry) => entry.id)).toEqual(['1', '2', '6953']);
    expect(input.selectedParticipants.map((entry) => entry.id)).toEqual(['1', '2']);
  });

  test('returns a bounded validation error when the administrator snapshot is unavailable', () => {
    expect(() => resolveTournamentEntrySeeds(plan(6953))).toThrow(
      expect.objectContaining({ code: 'TOURNAMENT_ADMIN_ENTRY_UNAVAILABLE' }),
    );
  });
});
