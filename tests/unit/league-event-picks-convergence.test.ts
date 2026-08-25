import { describe, expect, test } from 'bun:test';

import type { TournamentInfoSummary } from '../../src/repositories/tournament-infos';
import {
  syncLeagueEventPicksByTournament,
  type LeagueEventPicksDependencies,
} from '../../src/services/league-event-picks.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

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
      findEntryInfos: async () => [
        { id: 101, startedEvent: 1 },
        { id: 102, startedEvent: 1 },
        { id: 103, startedEvent: 1 },
      ],
      findPersistedEntryIds: async (_season, _eventId, entryIds) =>
        entryIds.filter((entryId) => persisted.has(entryId)),
      syncEntry: async (_season, entryId) => {
        calls.push(entryId);
        if (entryId === 103 && failEntry) throw new Error('injected upstream failure');
        persisted.add(entryId);
      },
    };

    await expect(
      syncLeagueEventPicksByTournament(TEST_SEASON, 77, 9, {
        concurrency: 2,
        dependencies,
      }),
    ).rejects.toMatchObject({
      code: 'DATA_SYNC_INCOMPLETE',
      requiredUnits: 2,
      reusedUnits: 1,
      succeededUnits: 1,
      failedUnits: 1,
    });
    expect(calls.sort()).toEqual([102, 103]);

    failEntry = false;
    const retry = await syncLeagueEventPicksByTournament(TEST_SEASON, 77, 9, {
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

  test('does not request picks before an entry started playing', async () => {
    const dependencies: LeagueEventPicksDependencies = {
      findTournament: async () => tournament,
      resolveEntryIds: async () => [201, 202],
      findEntryInfos: async () => [
        { id: 201, startedEvent: 2 },
        { id: 202, startedEvent: 3 },
      ],
      findPersistedEntryIds: async () => {
        throw new Error('should not query persisted picks for an empty eligible set');
      },
      syncEntry: async () => {
        throw new Error('should not fetch picks before an entry started');
      },
    };

    await expect(
      syncLeagueEventPicksByTournament(TEST_SEASON, 77, 1, { dependencies }),
    ).resolves.toMatchObject({
      totalEntries: 0,
      requiredUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    });
  });
});
