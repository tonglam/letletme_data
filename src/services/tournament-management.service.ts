import { z } from 'zod';

import {
  tournamentManagementRepository,
  type TournamentManagementRecord,
} from '../repositories/tournament-management';
import { normalizeTournamentName } from '../domain/tournament';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';

const updateTournamentSchema = z.object({
  name: z.string().trim().min(3).max(80),
  adminEntryId: z.number().int().positive(),
});

const deleteTournamentSchema = z.object({
  adminEntryId: z.number().int().positive(),
});

export type TournamentManagementRepository = {
  findById(tournamentId: number): Promise<TournamentManagementRecord | null>;
  checkNameExistsExcluding(name: string, tournamentId: number): Promise<boolean>;
  updateNameOwned(
    tournamentId: number,
    adminEntryId: number,
    name: string,
  ): Promise<TournamentManagementRecord | null>;
  deleteOwned(
    tournamentId: number,
    adminEntryId: number,
  ): Promise<
    | { status: 'deleted'; tournament: TournamentManagementRecord }
    | { status: 'not_found' }
    | { status: 'forbidden' }
  >;
};

export function createTournamentManagementService(repository: TournamentManagementRepository) {
  const assertOwner = async (tournamentId: number, adminEntryId: number) => {
    const tournament = await repository.findById(tournamentId);
    if (!tournament) {
      throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
    }
    if (tournament.adminEntryId !== adminEntryId) {
      throw new ForbiddenError(
        'Only the tournament administrator can manage this tournament.',
        'TOURNAMENT_ADMIN_REQUIRED',
      );
    }
    return tournament;
  };

  return {
    updateTournament: async (tournamentId: number, input: unknown) => {
      const payload = updateTournamentSchema.parse(input);
      const current = await assertOwner(tournamentId, payload.adminEntryId);
      const name = normalizeTournamentName(payload.name);
      if (current.name === name) return current;
      if (await repository.checkNameExistsExcluding(name, tournamentId)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      const updated = await repository.updateNameOwned(tournamentId, payload.adminEntryId, name);
      if (!updated) {
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      return updated;
    },

    deleteTournament: async (tournamentId: number, input: unknown) => {
      const payload = deleteTournamentSchema.parse(input);
      const result = await repository.deleteOwned(tournamentId, payload.adminEntryId);
      if (result.status === 'not_found') {
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      if (result.status === 'forbidden') {
        throw new ForbiddenError(
          'Only the tournament administrator can delete this tournament.',
          'TOURNAMENT_ADMIN_REQUIRED',
        );
      }
      return result.tournament;
    },
  };
}

export const tournamentManagementService = createTournamentManagementService(
  tournamentManagementRepository,
);
