import { describe, expect, test } from 'bun:test';

import type { TournamentInfoSummary } from '../../src/repositories/tournament-infos';
import {
  syncLeagueEventPicksByTournament,
  type LeagueEventPicksDependencies,
} from '../../src/services/league-event-picks.service';

const tournament = {
  id: 77,
  leagueId: 88,
  leagueType: 'classic',
  totalTeamNum: 3,
} as TournamentInfoSummary;

describe('league event picks convergence', () => {
  test('fails partial work, then retries only the exact missing entry', async () => {
    const persisted = new Set([101]);
    const calls: number[] = [];
    let failEntry = true;
    const dependencies: LeagueEventPicksDependencies = {
      findTournament: async () => tournament,
      resolveEntryIds: async () => [101, 102, 103],
      findPersistedEntryIds: async (_eventId, entryIds) =>
        entryIds.filter((entryId) => persisted.has(entryId)),
      syncEntry: async (entryId) => {
        calls.push(entryId);
        if (entryId === 103 && failEntry) throw new Error('injected upstream failure');
        persisted.add(entryId);
      },
    };

    await expect(
      syncLeagueEventPicksByTournament(77, 9, { concurrency: 2, dependencies }),
    ).rejects.toMatchObject({
      code: 'DATA_SYNC_INCOMPLETE',
      requiredUnits: 2,
      reusedUnits: 1,
      succeededUnits: 1,
      failedUnits: 1,
    });
    expect(calls.sort()).toEqual([102, 103]);

    failEntry = false;
    const retry = await syncLeagueEventPicksByTournament(77, 9, {
      concurrency: 2,
      dependencies,
    });
    expect(calls).toEqual([102, 103, 103]);
    expect(retry).toMatchObject({
      totalEntries: 3,
      requiredUnits: 1,
      reusedUnits: 2,
      succeededUnits: 1,
      failedUnits: 0,
    });
  });
});
