import { describe, expect, test } from 'bun:test';

import type { TournamentInfoSummary } from '../../src/repositories/tournament-infos';
import { resolveTournamentEntryIds } from '../../src/services/tournament-entry-resolver.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const tournament = {
  id: 7,
  leagueId: 8,
  leagueType: 'classic',
  totalTeamNum: 2,
} as TournamentInfoSummary;

describe('tournament entry resolver', () => {
  test('uses canonical stored membership', async () => {
    const result = await resolveTournamentEntryIds(TEST_SEASON, tournament, {
      findStoredEntryIds: async () => [3, 2, 3],
    });
    expect(result).toEqual([3, 2]);
  });

  test('fails closed when the canonical roster is missing', async () => {
    expect(
      resolveTournamentEntryIds(TEST_SEASON, tournament, {
        findStoredEntryIds: async () => [],
      }),
    ).rejects.toThrow('has no persisted roster');
  });

  test('fails closed when the canonical roster cardinality is incomplete', async () => {
    expect(
      resolveTournamentEntryIds(TEST_SEASON, tournament, {
        findStoredEntryIds: async () => [2],
      }),
    ).rejects.toThrow('persisted roster count 1 does not match expected 2');
  });
});
