import { z } from 'zod';

import {
  tournamentManagementRepository,
  type TournamentManagementRecord,
} from '../repositories/tournament-management';
import { normalizeTournamentName } from '../domain/tournament';
import type { FplSeasonRef } from '../domain/fpl-season';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { seasonRepository } from '../repositories/seasons';
import {
  refreshTournamentEntryEventSummariesMaterializedView,
  repairDeletedTournamentMaterializedViews,
} from './tournament-materialized-views.service';
import { refreshTournamentSelectionStatsMaterializedView } from './tournament-selection-stats.service';
import {
  enqueueTournamentRosterReconcile,
  findTournamentRosterReconcileJob,
} from '../jobs/tournament-sync.jobs';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { assertTournamentRosterPreGameweekBoundary } from './tournament-roster.service';

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
  findById(season: FplSeasonRef, tournamentId: number): Promise<TournamentManagementRecord | null>;
  checkNameExistsExcluding(
    season: FplSeasonRef,
    name: string,
    tournamentId: number,
  ): Promise<boolean>;
  updateNameOwned(
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    name: string,
  ): Promise<TournamentManagementRecord | null>;
  updateStateOwned(
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    state: 'active' | 'inactive',
  ): Promise<TournamentManagementRecord | null>;
  updateRosterModeOwned(
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    rosterMode: 'official_sync',
  ): Promise<TournamentManagementRecord | null>;
  deleteOwned(
    season: FplSeasonRef,
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
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
  ) => ReturnType<TournamentManagementRepository['deleteOwned']>;
  refreshViews?: () => Promise<unknown>;
  repairDeletedViews?: (tournamentId: number) => Promise<boolean>;
};

type SnapshotResumeDependencies = {
  enqueue: (
    tournamentId: number,
    source: 'resume',
    options: {
      forceNew: true;
      prepareEnqueue: () => Promise<void>;
    },
  ) => Promise<unknown>;
  markResumeProcessing: (tournamentId: number) => Promise<void>;
  markRosterFailed: (tournamentId: number, error: string) => Promise<void>;
  markSetupFailed: (tournamentId: number, error: string) => Promise<void>;
};

export async function requestSnapshotTournamentResume(
  tournamentId: number,
  dependencies: SnapshotResumeDependencies,
): Promise<void> {
  let resumePrepared = false;
  try {
    await dependencies.enqueue(tournamentId, 'resume', {
      forceNew: true,
      prepareEnqueue: async () => {
        await dependencies.markResumeProcessing(tournamentId);
        resumePrepared = true;
      },
    });
  } catch (error) {
    // An active job is rejected before prepareEnqueue runs. Preserve its
    // canonical state instead of replacing ready/processing with a false
    // pending or failed resume marker. Fail only a transition we wrote.
    if (resumePrepared) {
      const message = error instanceof Error ? error.message : 'Unable to enqueue resume setup.';
      await Promise.allSettled([
        dependencies.markRosterFailed(tournamentId, message),
        dependencies.markSetupFailed(tournamentId, message),
      ]);
    }
    throw error;
  }
}

export function createTournamentManagementService(
  repository: TournamentManagementRepository,
  lifecycle: TournamentManagementLifecycle = {},
  getSeason: () => Promise<FplSeasonRef> = () => seasonRepository.findCurrent(),
) {
  const assertOwner = async (season: FplSeasonRef, tournamentId: number, adminEntryId: number) => {
    const tournament = await repository.findById(season, tournamentId);
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

  const assertNoPendingOfficialResume = (tournament: TournamentManagementRecord) => {
    if (
      tournament.rosterMode === 'official_sync' &&
      tournament.state === 'inactive' &&
      (tournament.rosterSyncStatus === 'processing' || tournament.rosterSyncStatus === 'failed') &&
      (tournament.setupStatus === 'pending' ||
        tournament.setupStatus === 'processing' ||
        (tournament.setupStatus === 'failed' && tournament.setupError != null)) &&
      (tournament.setupStatus === 'processing' ||
        tournament.setupPhase === 'queued' ||
        tournament.setupPhase === 'failed')
    ) {
      throw new ConflictError(
        'Tournament activation is already reconciling its authoritative roster.',
        'TOURNAMENT_RESUME_PENDING',
      );
    }
  };

  const repairMissingDeletion = async (tournamentId: number): Promise<void> => {
    try {
      const repaired = await lifecycle.repairDeletedViews?.(tournamentId);
      if (repaired) return;
    } catch (error) {
      throw error;
    }
  };

  return {
    updateTournament: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = updateTournamentSchema.parse(input);
      const current = await assertOwner(season, tournamentId, payload.adminEntryId);
      const name = normalizeTournamentName(payload.name);
      if (current.name === name) {
        return current;
      }
      if (await repository.checkNameExistsExcluding(season, name, tournamentId)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      const updated = await repository.updateNameOwned(
        season,
        tournamentId,
        payload.adminEntryId,
        name,
      );
      if (!updated) {
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      return updated;
    },

    setTournamentState: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = tournamentStateSchema.parse(input);
      const current = await assertOwner(season, tournamentId, payload.adminEntryId);
      if (current.state === 'finished') {
        throw new ConflictError('Finished tournaments cannot be resumed.', 'TOURNAMENT_FINISHED');
      }
      // An inactive tournament can still carry a processing marker for a queued
      // resume. Run the pause update again so the owner's newer pause clears
      // that marker and markReadyAndResume cannot reactivate it later.
      if (current.state === payload.state && payload.state !== 'inactive') return current;

      if (payload.state === 'inactive') {
        const paused = await withMutationConflictGuard(
          {
            queueName: 'tournament-management',
            jobName: 'tournament-pause',
            tournamentId,
            scopes: [tournamentSetupLifecycleScope(tournamentId)],
          },
          () => repository.updateStateOwned(season, tournamentId, payload.adminEntryId, 'inactive'),
        );
        if (!paused) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
        return paused;
      }

      await withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-resume',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const lockedCurrent = await repository.findById(season, tournamentId);
          if (!lockedCurrent) {
            throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
          }
          if (lockedCurrent.adminEntryId !== payload.adminEntryId) {
            throw new ForbiddenError(
              'Only the tournament administrator can manage this tournament.',
              'TOURNAMENT_ADMIN_REQUIRED',
            );
          }
          if (lockedCurrent.state !== 'inactive' || lockedCurrent.updatedAt !== current.updatedAt) {
            throw new ConflictError(
              'Tournament state changed while resume was waiting.',
              'TOURNAMENT_STATE_CHANGED',
            );
          }

          if (lockedCurrent.rosterMode === 'official_sync') {
            await assertTournamentRosterPreGameweekBoundary(season);
            // Publish the cancellable intent before queueing. A newer pause
            // changes this marker back to ready, so a queued worker can never
            // reactivate a tournament after the owner has paused it.
            const resumeMarker = await tournamentRosterRepository.markResumeProcessingWithMarker(
              season,
              tournamentId,
            );
            try {
              await enqueueTournamentRosterReconcile(season, tournamentId, 'manual', {
                resumeAfterSetup: true,
                resumeMarker,
                allowInactive: true,
              });
            } catch (error) {
              // A lost Redis response is ambiguous. If the deterministic
              // resume job exists, keep the accepted transition intact.
              const accepted = await findTournamentRosterReconcileJob(
                season,
                tournamentId,
                true,
                resumeMarker,
              ).catch(() => null);
              if (accepted) return;
              const message = error instanceof Error ? error.message : 'Unable to enqueue resume.';
              await Promise.allSettled([
                tournamentRosterRepository.markSyncFailed(season, tournamentId, message),
                tournamentInfoRepository.markSetupResult(season, tournamentId, 'failed', message),
              ]);
              throw error;
            }
          } else {
            const { enqueueTournamentSetup } = await import('../jobs/tournament-setup.jobs');
            await requestSnapshotTournamentResume(tournamentId, {
              enqueue: (id, source, options) => enqueueTournamentSetup(season, id, source, options),
              markResumeProcessing: (id) =>
                tournamentRosterRepository.markResumeProcessing(season, id),
              markRosterFailed: (id, message) =>
                tournamentRosterRepository.markSyncFailed(season, id, message),
              markSetupFailed: (id, message) =>
                tournamentInfoRepository.markSetupResult(season, id, 'failed', message),
            });
          }
        },
      );
      return (await repository.findById(season, tournamentId)) ?? current;
    },

    setRosterMode: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = rosterModeSchema.parse(input);
      return withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-roster-mode',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertOwner(season, tournamentId, payload.adminEntryId);
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
          if (current.rosterMode === payload.rosterMode && current.rosterSyncStatus !== 'failed')
            return current;
          if (current.state === 'active') {
            // Do not persist an opt-in that cannot be reconciled at the current
            // gameweek boundary. The check happens before the mode mutation.
            await assertTournamentRosterPreGameweekBoundary(season);
          }
          const updated = await repository.updateRosterModeOwned(
            season,
            tournamentId,
            payload.adminEntryId,
            payload.rosterMode,
          );
          if (!updated) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
          if (updated.state === 'active' && updated.rosterMode === 'official_sync') {
            try {
              const rosterState = await tournamentRosterRepository.findById(season, tournamentId);
              await enqueueTournamentRosterReconcile(season, tournamentId, 'manual', {
                settleBoundaryFailure: true,
                expectedProgressMarker: rosterState?.setupProgressUpdatedAt ?? null,
              });
            } catch (error) {
              await tournamentRosterRepository.markSyncFailed(
                season,
                tournamentId,
                error instanceof Error ? error.message : 'Unable to enqueue roster reconciliation.',
              );
              throw error;
            }
          }
          return (await repository.findById(season, tournamentId)) ?? updated;
        },
      );
    },

    retrySetup: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = tournamentOwnerSchema.parse(input);
      return withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-setup-retry',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertOwner(season, tournamentId, payload.adminEntryId);
          assertNoPendingOfficialResume(current);
          const { requeueTournamentSetup } = await import('./tournament-setup.service');
          return requeueTournamentSetup(season, tournamentId);
        },
      );
    },

    retryRoster: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = tournamentOwnerSchema.parse(input);
      return withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-roster-retry',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertOwner(season, tournamentId, payload.adminEntryId);
          if (current.rosterMode !== 'official_sync') {
            throw new ValidationError(
              'Tournament roster is a fixed snapshot.',
              'TOURNAMENT_ROSTER_SNAPSHOT',
            );
          }
          if (current.state === 'finished') {
            throw new ConflictError('Tournament is already finished.', 'TOURNAMENT_FINISHED');
          }
          assertNoPendingOfficialResume(current);
          await assertTournamentRosterPreGameweekBoundary(season);
          const rosterState = await tournamentRosterRepository.findById(season, tournamentId);
          const job = await enqueueTournamentRosterReconcile(season, tournamentId, 'manual', {
            allowInactive: true,
            settleBoundaryFailure: true,
            expectedProgressMarker: rosterState?.setupProgressUpdatedAt ?? null,
          });
          return {
            tournamentId,
            changed: false,
            queued: true,
            operationId: job.id ?? null,
            status: 'pending' as const,
          };
        },
      );
    },

    deleteTournament: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = deleteTournamentSchema.parse(input);
      const current = await repository.findById(season, tournamentId);
      if (!current) {
        await repairMissingDeletion(tournamentId);
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      if (current.adminEntryId !== payload.adminEntryId) {
        throw new ForbiddenError(
          'Only the tournament administrator can delete this tournament.',
          'TOURNAMENT_ADMIN_REQUIRED',
        );
      }
      const result = lifecycle.deleteOwned
        ? await lifecycle.deleteOwned(season, tournamentId, payload.adminEntryId)
        : await repository.deleteOwned(season, tournamentId, payload.adminEntryId);
      if (result.status === 'not_found') {
        await repairMissingDeletion(tournamentId);
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
      if (refreshError) throw refreshError;
      return result.tournament;
    },
  };
}

export const tournamentManagementService = createTournamentManagementService(
  tournamentManagementRepository,
  {
    refreshViews: async () => {
      await refreshTournamentSelectionStatsMaterializedView();
      await refreshTournamentEntryEventSummariesMaterializedView();
    },
    repairDeletedViews: repairDeletedTournamentMaterializedViews,
    deleteOwned: async (season, tournamentId, adminEntryId) => {
      const { cancelWaitingTournamentSetupJobs } = await import('../jobs/tournament-setup.jobs');
      const { cancelWaitingTournamentRosterReconcileJobs } = await import(
        '../jobs/tournament-sync.jobs'
      );
      const { tournamentSetupLifecycleScope } = await import('../domain/mutation-scope');
      const { withMutationConflictGuard } = await import('../utils/mutation-lock');
      return withMutationConflictGuard(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-delete',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          // Cancel after acquiring the same lifecycle lock as enqueueing and
          // deletion. A worker that already crossed this boundary is harmless
          // because the worker treats an authoritative delete as a no-op.
          await cancelWaitingTournamentSetupJobs(tournamentId);
          await cancelWaitingTournamentRosterReconcileJobs(tournamentId);
          return tournamentManagementRepository.deleteOwned(season, tournamentId, adminEntryId);
        },
      );
    },
  },
);
