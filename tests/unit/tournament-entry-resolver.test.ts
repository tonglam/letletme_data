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
  test('uses canonical stored membership without calling FPL', async () => {
    let fallbackCalls = 0;
    const result = await resolveTournamentEntryIds(TEST_SEASON, tournament, {
      findStoredEntryIds: async () => [3, 2, 3],
      fetchAuthoritativeEntryIds: async () => {
        fallbackCalls += 1;
        return [9];
      },
    });
    expect(result).toEqual([3, 2]);
    expect(fallbackCalls).toBe(0);
  });

  test('uses the bounded authoritative fallback only for a legacy empty roster', async () => {
    const result = await resolveTournamentEntryIds(TEST_SEASON, tournament, {
      findStoredEntryIds: async () => [],
      fetchAuthoritativeEntryIds: async () => [11, 12, 12, 13],
    });
    expect(result).toEqual([11, 12]);
  });
});
