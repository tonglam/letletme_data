import { describe, expect, test } from 'bun:test';

import type { TournamentManagementRecord } from '../../src/repositories/tournament-management';
import {
  createTournamentManagementService,
  type TournamentManagementRepository,
} from '../../src/services/tournament-management.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/utils/errors';

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
    updateNameOwned: async (_id, _adminEntryId, name) => ({ ...tournament, name }),
    updateStateOwned: async (_id, _adminEntryId, state) => ({ ...tournament, state }),
    updateRosterModeOwned: async (_id, _adminEntryId, rosterMode) => ({
      ...tournament,
      rosterMode,
    }),
    deleteOwned: async () => ({ status: 'deleted', tournament }),
    ...overrides,
  };
}

describe('tournament management service', () => {
  test('updates only an administrator-owned tournament and trims the name', async () => {
    let updatedName = '';
    const service = createTournamentManagementService(
      createRepository({
        updateNameOwned: async (_id, _adminEntryId, name) => {
          updatedName = name;
          return { ...tournament, name };
        },
      }),
    );

    const updated = await service.updateTournament(42, {
      name: '  Renamed Cup  ',
      adminEntryId: 123,
    });

    expect(updated.name).toBe('Renamed Cup');
    expect(updatedName).toBe('Renamed Cup');
  });

  test('rejects updates from a different FPL entry', async () => {
    const service = createTournamentManagementService(createRepository());
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 999 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('rejects a duplicate tournament name', async () => {
    const service = createTournamentManagementService(
      createRepository({ checkNameExistsExcluding: async () => true }),
    );
    await expect(
      service.updateTournament(42, { name: 'Existing Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('returns not found when the tournament does not exist', async () => {
    const service = createTournamentManagementService(
      createRepository({ findById: async () => null }),
    );
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('does not enable official roster synchronization after a tournament finishes', async () => {
    const service = createTournamentManagementService(
      createRepository({ findById: async () => ({ ...tournament, state: 'finished' }) }),
    );
    await expect(
      service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('re-applies an inactive state so a newer pause can withdraw a pending resume', async () => {
    let updates = 0;
    const service = createTournamentManagementService(
      createRepository({
        findById: async () => ({ ...tournament, state: 'inactive' }),
        updateStateOwned: async (_id, _adminEntryId, state) => {
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
    const service = createTournamentManagementService(
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
        invalidateCaches: async () => {
          calls.push('invalidate-caches');
        },
      },
    );
    const deleted = await service.deleteTournament(42, { adminEntryId: 123 });
    expect(deleted).toEqual(tournament);
    expect(calls).toEqual(['delete', 'refresh-views', 'invalidate-caches']);
  });

  test('rejects deletion from a different FPL entry', async () => {
    const service = createTournamentManagementService(
      createRepository({ deleteOwned: async () => ({ status: 'forbidden' }) }),
    );
    await expect(service.deleteTournament(42, { adminEntryId: 999 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test('invalidates deletion caches even when materialized-view refresh fails', async () => {
    const calls: string[] = [];
    const refreshError = new Error('refresh failed');
    const service = createTournamentManagementService(createRepository(), {
      refreshViews: async () => {
        calls.push('refresh-views');
        throw refreshError;
      },
      invalidateCaches: async () => {
        calls.push('invalidate-caches');
      },
    });

    await expect(service.deleteTournament(42, { adminEntryId: 123 })).rejects.toBe(refreshError);
    expect(calls).toEqual(['refresh-views', 'invalidate-caches']);
  });
});
