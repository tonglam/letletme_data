import { describe, expect, test } from 'bun:test';

import type { TournamentManagementRecord } from '../../src/repositories/tournament-management';
import { eventRepository } from '../../src/repositories/events';
import {
  createTournamentManagementService as createServiceUnderTest,
  requestSnapshotTournamentResume,
  type TournamentManagementRepository,
} from '../../src/services/tournament-management.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/utils/errors';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const tournament: TournamentManagementRecord = {
  id: 42,
  name: 'Original Cup',
  creator: 'Manager',
  adminEntryId: 123,
  totalTeamNum: 8,
  leagueType: 'classic',
  groupMode: 'points_races',
  groupNum: 1,
  knockoutMode: 'no_knockout',
  rosterMode: 'snapshot',
  state: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function createRepository(
  overrides: Partial<TournamentManagementRepository> = {},
): TournamentManagementRepository {
  return {
    findById: async () => tournament,
    checkNameExistsExcluding: async () => false,
    updateNameOwned: async (_season, _id, _adminEntryId, name) => ({ ...tournament, name }),
    updateStateOwned: async (_season, _id, _adminEntryId, state) => ({ ...tournament, state }),
    updateRosterModeOwned: async (_season, _id, _adminEntryId, rosterMode) => ({
      ...tournament,
      rosterMode,
    }),
    deleteOwned: async () => ({ status: 'deleted', tournament }),
    ...overrides,
  };
}

function createTestService(
  repository: TournamentManagementRepository,
  lifecycle: Parameters<typeof createServiceUnderTest>[1] = {},
) {
  return createServiceUnderTest(repository, lifecycle, async () => TEST_SEASON);
}

describe('tournament management service', () => {
  test('does not publish resume markers when an active setup rejects the replacement', async () => {
    const calls: string[] = [];
    const activeError = new ConflictError(
      'Tournament setup is already running.',
      'TOURNAMENT_SETUP_IN_PROGRESS',
    );

    await expect(
      requestSnapshotTournamentResume(42, {
        enqueue: async () => {
          calls.push('enqueue-rejected');
          throw activeError;
        },
        markResumeProcessing: async () => {
          calls.push('mark-pending');
        },
        markRosterFailed: async () => {
          calls.push('mark-roster-failed');
        },
        markSetupFailed: async () => {
          calls.push('mark-setup-failed');
        },
      }),
    ).rejects.toBe(activeError);

    expect(calls).toEqual(['enqueue-rejected']);
  });

  test('marks only a prepared resume failed when queue publication fails', async () => {
    const calls: string[] = [];
    const enqueueError = new Error('queue unavailable');

    await expect(
      requestSnapshotTournamentResume(42, {
        enqueue: async (_id, _source, options) => {
          await options.prepareEnqueue();
          calls.push('enqueue-failed');
          throw enqueueError;
        },
        markResumeProcessing: async () => {
          calls.push('mark-pending');
        },
        markRosterFailed: async () => {
          calls.push('mark-roster-failed');
        },
        markSetupFailed: async () => {
          calls.push('mark-setup-failed');
        },
      }),
    ).rejects.toBe(enqueueError);

    expect(calls).toEqual([
      'mark-pending',
      'enqueue-failed',
      'mark-roster-failed',
      'mark-setup-failed',
    ]);
  });

  test('updates only an administrator-owned tournament and trims the name', async () => {
    let updatedName = '';
    const calls: string[] = [];
    const service = createTestService(
      createRepository({
        updateNameOwned: async (_season, _id, _adminEntryId, name) => {
          updatedName = name;
          return { ...tournament, name };
        },
      }),
      {
        refreshViews: async () => {
          calls.push('refresh-views');
        },
      },
    );

    const updated = await service.updateTournament(42, {
      name: '  Renamed Cup  ',
      adminEntryId: 123,
    });

    expect(updated.name).toBe('Renamed Cup');
    expect(updatedName).toBe('Renamed Cup');
    expect(calls).toEqual([]);
  });

  test('rejects updates from a different FPL entry', async () => {
    const service = createTestService(createRepository());
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 999 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('returns a same-name retry without refreshing unrelated reporting views', async () => {
    const calls: string[] = [];
    const service = createTestService(createRepository(), {
      refreshViews: async () => {
        calls.push('refresh-views');
      },
    });

    const unchanged = await service.updateTournament(42, {
      name: tournament.name,
      adminEntryId: tournament.adminEntryId,
    });

    expect(unchanged).toEqual(tournament);
    expect(calls).toEqual([]);
  });

  test('rejects a duplicate tournament name', async () => {
    const service = createTestService(
      createRepository({ checkNameExistsExcluding: async () => true }),
    );
    await expect(
      service.updateTournament(42, { name: 'Existing Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('returns not found when the tournament does not exist', async () => {
    const service = createTestService(createRepository({ findById: async () => null }));
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('does not enable official roster synchronization after a tournament finishes', async () => {
    const service = createTestService(
      createRepository({ findById: async () => ({ ...tournament, state: 'finished' }) }),
    );
    await expect(
      service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('does not persist official-sync opt-in during an active gameweek', async () => {
    const originalFindCurrent = eventRepository.findCurrent;
    let updates = 0;
    eventRepository.findCurrent = async () =>
      ({ dataChecked: false }) as Awaited<ReturnType<typeof originalFindCurrent>>;

    try {
      const service = createTestService(
        createRepository({
          updateRosterModeOwned: async (_season, _id, _adminEntryId, rosterMode) => {
            updates += 1;
            return { ...tournament, rosterMode };
          },
        }),
      );

      await expect(
        service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
      ).rejects.toMatchObject({ code: 'TOURNAMENT_ROSTER_FROZEN' });
      expect(updates).toBe(0);
    } finally {
      eventRepository.findCurrent = originalFindCurrent;
    }
  });

  test('re-applies an inactive state so a newer pause can withdraw a pending resume', async () => {
    let updates = 0;
    const service = createTestService(
      createRepository({
        findById: async () => ({ ...tournament, state: 'inactive' }),
        updateStateOwned: async (_season, _id, _adminEntryId, state) => {
          updates += 1;
          return { ...tournament, state };
        },
      }),
    );

    const paused = await service.setTournamentState(42, {
      adminEntryId: 123,
      state: 'inactive',
    });

    expect(paused.state).toBe('inactive');
    expect(updates).toBe(1);
  });

  test('deletes an owned tournament', async () => {
    const calls: string[] = [];
    const service = createTestService(
      createRepository({
        deleteOwned: async () => {
          calls.push('delete');
          return { status: 'deleted', tournament };
        },
      }),
      {
        refreshViews: async () => {
          calls.push('refresh-views');
        },
      },
    );
    const deleted = await service.deleteTournament(42, { adminEntryId: 123 });
    expect(deleted).toEqual(tournament);
    expect(calls).toEqual(['delete', 'refresh-views']);
  });

  test('rejects deletion from a different FPL entry', async () => {
    const service = createTestService(
      createRepository({ deleteOwned: async () => ({ status: 'forbidden' }) }),
    );
    await expect(service.deleteTournament(42, { adminEntryId: 999 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test('surfaces a materialized-view refresh failure after canonical deletion', async () => {
    const calls: string[] = [];
    const refreshError = new Error('refresh failed');
    const service = createTestService(createRepository(), {
      refreshViews: async () => {
        calls.push('refresh-views');
        throw refreshError;
      },
    });

    await expect(service.deleteTournament(42, { adminEntryId: 123 })).rejects.toBe(refreshError);
    expect(calls).toEqual(['refresh-views']);
  });

  test('repairs a stale deleted snapshot when an owner retries after refresh failure', async () => {
    const calls: string[] = [];
    const service = createTestService(createRepository({ findById: async () => null }), {
      repairDeletedViews: async (tournamentId) => {
        calls.push(`repair-views:${tournamentId}`);
        return true;
      },
    });

    await expect(
      service.deleteTournament(42, { adminEntryId: tournament.adminEntryId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(['repair-views:42']);
  });
});
