import { z } from 'zod';

import {
  tournamentManagementRepository,
  type TournamentManagementRecord,
} from '../repositories/tournament-management';
import { normalizeTournamentName } from '../domain/tournament';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { invalidateTournamentGraphQLCaches } from '../cache/tournament-graphql-cache';
import { refreshTournamentMaterializedViews } from './tournament-materialized-views.service';

const updateTournamentSchema = z.object({
  name: z.string().trim().min(3).max(80),
  adminEntryId: z.number().int().positive(),
});

const deleteTournamentSchema = z.object({
  adminEntryId: z.number().int().positive(),
});

const tournamentStateSchema = z.object({
  adminEntryId: z.number().int().positive(),
  state: z.enum(['active', 'inactive']),
});

const tournamentOwnerSchema = z.object({
  adminEntryId: z.number().int().positive(),
});

const rosterModeSchema = z.object({
  adminEntryId: z.number().int().positive(),
  rosterMode: z.literal('official_sync'),
});

export type TournamentManagementRepository = {
  findById(tournamentId: number): Promise<TournamentManagementRecord | null>;
  checkNameExistsExcluding(name: string, tournamentId: number): Promise<boolean>;
  updateNameOwned(
    tournamentId: number,
    adminEntryId: number,
    name: string,
  ): Promise<TournamentManagementRecord | null>;
  updateStateOwned(
    tournamentId: number,
    adminEntryId: number,
    state: 'active' | 'inactive',
  ): Promise<TournamentManagementRecord | null>;
  updateRosterModeOwned(
    tournamentId: number,
    adminEntryId: number,
    rosterMode: 'official_sync',
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

export type TournamentManagementLifecycle = {
  deleteOwned?: (
    tournamentId: number,
    adminEntryId: number,
  ) => ReturnType<TournamentManagementRepository['deleteOwned']>;
  invalidateCaches?: (reason: string) => Promise<unknown>;
  refreshViews?: () => Promise<unknown>;
};

export function createTournamentManagementService(
  repository: TournamentManagementRepository,
  lifecycle: TournamentManagementLifecycle = {},
) {
  const invalidateCaches = lifecycle.invalidateCaches ?? (async () => undefined);

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
      await invalidateCaches('rename');
      return updated;
    },

    setTournamentState: async (tournamentId: number, input: unknown) => {
      const payload = tournamentStateSchema.parse(input);
      const current = await assertOwner(tournamentId, payload.adminEntryId);
      if (current.state === 'finished') {
        throw new ConflictError('Finished tournaments cannot be resumed.', 'TOURNAMENT_FINISHED');
      }
      // An inactive tournament can still carry a processing marker for a queued
      // resume. Run the pause update again so the owner's newer pause clears
      // that marker and markReadyAndResume cannot reactivate it later.
      if (current.state === payload.state && payload.state !== 'inactive') return current;

      if (payload.state === 'inactive') {
        const paused = await repository.updateStateOwned(
          tournamentId,
          payload.adminEntryId,
          'inactive',
        );
        if (!paused) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
        await invalidateCaches('pause');
        return paused;
      }

      if (current.rosterMode === 'official_sync') {
        const { reconcileTournamentRoster } = await import('./tournament-roster.service');
        await reconcileTournamentRoster(tournamentId, {
          allowInactive: true,
          resumeAfterSetup: true,
        });
      } else {
        const { enqueueTournamentSetup } = await import('../jobs/tournament-setup.jobs');
        await tournamentRosterRepository.markResumeProcessing(tournamentId);
        try {
          await enqueueTournamentSetup(tournamentId, 'resume', { forceNew: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unable to enqueue resume setup.';
          await Promise.allSettled([
            tournamentRosterRepository.markSyncFailed(tournamentId, message),
            tournamentInfoRepository.markSetupResult(tournamentId, 'failed', message),
          ]);
          throw error;
        }
      }
      await invalidateCaches('resume-requested');
      return (await repository.findById(tournamentId)) ?? current;
    },

    setRosterMode: async (tournamentId: number, input: unknown) => {
      const payload = rosterModeSchema.parse(input);
      const current = await assertOwner(tournamentId, payload.adminEntryId);
      if (current.state === 'finished') {
        throw new ConflictError(
          'Finished tournaments cannot enable roster synchronization.',
          'TOURNAMENT_FINISHED',
        );
      }
      const eligible =
        current.leagueType === 'classic' &&
        current.groupMode === 'points_races' &&
        current.groupNum === 1 &&
        current.knockoutMode === 'no_knockout';
      if (!eligible) {
        throw new ConflictError(
          'This tournament format cannot use official roster synchronization.',
          'TOURNAMENT_ROSTER_MODE_INELIGIBLE',
        );
      }
      if (current.rosterMode === payload.rosterMode) return current;
      const updated = await repository.updateRosterModeOwned(
        tournamentId,
        payload.adminEntryId,
        payload.rosterMode,
      );
      if (!updated) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      if (updated.state === 'active') {
        const { reconcileTournamentRoster } = await import('./tournament-roster.service');
        await reconcileTournamentRoster(tournamentId);
      }
      await invalidateCaches('roster-mode');
      return (await repository.findById(tournamentId)) ?? updated;
    },

    retrySetup: async (tournamentId: number, input: unknown) => {
      const payload = tournamentOwnerSchema.parse(input);
      await assertOwner(tournamentId, payload.adminEntryId);
      const { requeueTournamentSetup } = await import('./tournament-setup.service');
      return requeueTournamentSetup(tournamentId);
    },

    retryRoster: async (tournamentId: number, input: unknown) => {
      const payload = tournamentOwnerSchema.parse(input);
      await assertOwner(tournamentId, payload.adminEntryId);
      const { reconcileTournamentRoster } = await import('./tournament-roster.service');
      return reconcileTournamentRoster(tournamentId, { allowInactive: true });
    },

    deleteTournament: async (tournamentId: number, input: unknown) => {
      const payload = deleteTournamentSchema.parse(input);
      await assertOwner(tournamentId, payload.adminEntryId);
      const result = lifecycle.deleteOwned
        ? await lifecycle.deleteOwned(tournamentId, payload.adminEntryId)
        : await repository.deleteOwned(tournamentId, payload.adminEntryId);
      if (result.status === 'not_found') {
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      if (result.status === 'forbidden') {
        throw new ForbiddenError(
          'Only the tournament administrator can delete this tournament.',
          'TOURNAMENT_ADMIN_REQUIRED',
        );
      }
      let refreshError: unknown = null;
      try {
        await lifecycle.refreshViews?.();
      } catch (error) {
        refreshError = error;
      }
      await invalidateCaches('delete');
      if (refreshError) throw refreshError;
      return result.tournament;
    },
  };
}

export const tournamentManagementService = createTournamentManagementService(
  tournamentManagementRepository,
  {
    invalidateCaches: invalidateTournamentGraphQLCaches,
    refreshViews: refreshTournamentMaterializedViews,
    deleteOwned: async (tournamentId, adminEntryId) => {
      const { cancelWaitingTournamentSetupJobs } = await import('../jobs/tournament-setup.jobs');
      const { tournamentSetupLifecycleScope } = await import('../domain/mutation-scope');
      const { withMutationConflictGuard } = await import('../utils/mutation-lock');
      await cancelWaitingTournamentSetupJobs(tournamentId);
      return withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-delete',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        () => tournamentManagementRepository.deleteOwned(tournamentId, adminEntryId),
      );
    },
  },
);
