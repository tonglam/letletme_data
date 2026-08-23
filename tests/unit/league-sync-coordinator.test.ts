import { describe, expect, test } from 'bun:test';

import { syncActiveLeagueTournaments } from '../../src/services/league-sync.service';
import { IncompleteDataSyncError } from '../../src/utils/errors';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('league sync coordinator', () => {
  test('does not finish until every active tournament converges', async () => {
    const completed: number[] = [];
    const result = await syncActiveLeagueTournaments({
      season: TEST_SEASON,
      eventId: 12,
      label: 'results',
      findActiveTournaments: async () => [{ id: 11 }, { id: 22 }],
      syncTournament: async (tournamentId) => {
        await Promise.resolve();
        completed.push(tournamentId);
        return {
          requiredUnits: tournamentId === 11 ? 3 : 2,
          reusedUnits: tournamentId === 11 ? 1 : 4,
          succeededUnits: tournamentId === 11 ? 3 : 2,
          failedUnits: 0,
        };
      },
    });

    expect(completed.sort((left, right) => left - right)).toEqual([11, 22]);
    expect(result).toEqual({
      tournaments: 2,
      requiredUnits: 5,
      reusedUnits: 5,
      succeededUnits: 5,
      failedUnits: 0,
    });
  });

  test('aggregates one tournament failure so BullMQ and the obligation retry', async () => {
    let captured: unknown;
    try {
      await syncActiveLeagueTournaments({
        season: TEST_SEASON,
        eventId: 12,
        label: 'picks',
        findActiveTournaments: async () => [{ id: 11 }, { id: 22 }],
        syncTournament: async (tournamentId) => {
          if (tournamentId === 22) {
            throw new IncompleteDataSyncError('controlled incomplete tournament', 4, 1, 3, 1);
          }
          return {
            requiredUnits: 2,
            reusedUnits: 3,
            succeededUnits: 2,
            failedUnits: 0,
          };
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(IncompleteDataSyncError);
    expect(captured).toMatchObject({
      requiredUnits: 6,
      reusedUnits: 4,
      succeededUnits: 5,
      failedUnits: 1,
    });
  });

  test('settles an empty active-tournament set without inventing work', async () => {
    const result = await syncActiveLeagueTournaments({
      season: TEST_SEASON,
      eventId: 12,
      label: 'results',
      findActiveTournaments: async () => [],
      syncTournament: async () => {
        throw new Error('should not run');
      },
    });

    expect(result).toEqual({
      tournaments: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    });
  });
});
