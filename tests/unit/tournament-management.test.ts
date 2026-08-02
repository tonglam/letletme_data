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

  test('deletes an owned tournament', async () => {
    const service = createTournamentManagementService(createRepository());
    const deleted = await service.deleteTournament(42, { adminEntryId: 123 });
    expect(deleted).toEqual(tournament);
  });

  test('rejects deletion from a different FPL entry', async () => {
    const service = createTournamentManagementService(
      createRepository({ deleteOwned: async () => ({ status: 'forbidden' }) }),
    );
    await expect(service.deleteTournament(42, { adminEntryId: 999 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
