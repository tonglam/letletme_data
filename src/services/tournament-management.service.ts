import { z } from 'zod';

import {
  tournamentManagementRepository,
  type TournamentManagementRecord,
} from '../repositories/tournament-management';
import { normalizeTournamentName } from '../domain/tournament';
import type { FplSeasonRef } from '../domain/fpl-season';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import {
  tournamentRosterRepository,
  ownsTournamentRosterExecution,
} from '../repositories/tournament-roster';
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
import { findTournamentSetupJob } from '../jobs/tournament-setup.jobs';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { withMutationScopes } from '../utils/mutation-scopes';
import { assertTournamentRosterPreGameweekBoundary } from './tournament-roster.service';
import {
  dispatchMyFplSnapshotInvalidationOutbox,
  type MyFplSnapshotInvalidationDispatchOptions,
} from './my-fpl-snapshot-invalidation.service';
import { logWarn } from '../utils/logger';
import {
  canManageTournament,
  isOfficialRosterSyncEligible,
  type TournamentManagementActor,
} from '../domain/tournament-management';

const updateTournamentSchema = z.object({
  name: z.string().trim().min(3).max(80),
  adminEntryId: z.number().int().positive(),
  platformAdmin: z.boolean().optional().default(false),
});

const deleteTournamentSchema = z.object({
  adminEntryId: z.number().int().positive(),
  platformAdmin: z.boolean().optional().default(false),
});

const tournamentStateSchema = z.object({
  adminEntryId: z.number().int().positive(),
  platformAdmin: z.boolean().optional().default(false),
  state: z.enum(['active', 'inactive']),
});

const tournamentOwnerSchema = z.object({
  adminEntryId: z.number().int().positive(),
  platformAdmin: z.boolean().optional().default(false),
});

const rosterModeSchema = z.object({
  adminEntryId: z.number().int().positive(),
  platformAdmin: z.boolean().optional().default(false),
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
    options?: { settleResume?: boolean },
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
    | {
        status: 'deleted';
        tournament: TournamentManagementRecord;
        invalidationOutboxIds?: readonly string[];
      }
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
  dispatchInvalidations?: (
    options: MyFplSnapshotInvalidationDispatchOptions,
  ) => ReturnType<typeof dispatchMyFplSnapshotInvalidationOutbox>;
  reconcileInvalidations?: (
    season: FplSeasonRef,
    tournamentId: number,
  ) => ReturnType<typeof dispatchMyFplSnapshotInvalidationOutbox>;
  refreshViews?: () => Promise<unknown>;
  repairDeletedViews?: (tournamentId: number) => Promise<boolean>;
  /** Injectable for hermetic service tests; production keeps the DB scopes. */
  withMutationScopes?: MutationScopeRunner;
  findRosterReconcileJob?: typeof findTournamentRosterReconcileJob;
  findSetupJob?: typeof findTournamentSetupJob;
  assertRosterBoundary?: typeof assertTournamentRosterPreGameweekBoundary;
  rosterRepository?: Pick<
    typeof tournamentRosterRepository,
    'findById' | 'markResumeProcessingWithMarker' | 'markResumeProcessing' | 'markSyncFailed'
  >;
  infoRepository?: Pick<typeof tournamentInfoRepository, 'markSetupResult'>;
  enqueueRosterReconcile?: typeof enqueueTournamentRosterReconcile;
  enqueueSnapshotSetup?: (
    season: FplSeasonRef,
    tournamentId: number,
    source: 'resume',
    options: Parameters<SnapshotResumeDependencies['enqueue']>[2],
  ) => Promise<unknown>;
  requeueSetup?: (
    season: FplSeasonRef,
    tournamentId: number,
  ) => Promise<{ readonly id?: string | number | null }>;
};

type MutationScopeRunner = <T>(
  input: Parameters<typeof withMutationScopes>[0],
  operation: () => Promise<T>,
) => Promise<T>;

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
  const scopeRunner = lifecycle.withMutationScopes ?? withMutationScopes;
  const findRosterReconcileJob =
    lifecycle.findRosterReconcileJob ?? findTournamentRosterReconcileJob;
  const findSetupJob = lifecycle.findSetupJob ?? findTournamentSetupJob;
  const assertRosterBoundary =
    lifecycle.assertRosterBoundary ?? assertTournamentRosterPreGameweekBoundary;
  const rosterRepository = lifecycle.rosterRepository ?? tournamentRosterRepository;
  const infoRepository = lifecycle.infoRepository ?? tournamentInfoRepository;
  const enqueueRosterReconcile =
    lifecycle.enqueueRosterReconcile ?? enqueueTournamentRosterReconcile;
  const enqueueSnapshotSetup =
    lifecycle.enqueueSnapshotSetup ??
    (async (season, tournamentId, source, options) => {
      const { enqueueTournamentSetup } = await import('../jobs/tournament-setup.jobs');
      return enqueueTournamentSetup(season, tournamentId, source, options);
    });
  const requeueSetup =
    lifecycle.requeueSetup ??
    (async (season, tournamentId) => {
      const { requeueTournamentSetup } = await import('./tournament-setup.service');
      return requeueTournamentSetup(season, tournamentId);
    });

  const assertCanManage = async (
    season: FplSeasonRef,
    tournamentId: number,
    actor: TournamentManagementActor,
  ) => {
    const tournament = await repository.findById(season, tournamentId);
    if (!tournament) {
      throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
    }
    if (!canManageTournament(tournament, actor)) {
      throw new ForbiddenError(
        'Only the tournament administrator can manage this tournament.',
        'TOURNAMENT_ADMIN_REQUIRED',
      );
    }
    return tournament;
  };

  const assertNoPendingOfficialResume = async (
    season: FplSeasonRef,
    tournament: TournamentManagementRecord,
  ) => {
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
      // The committed marker owns the handoff even before BullMQ accepts it.
      // Only a terminal failed resume may use queue absence to permit retry.
      if (tournament.setupStatus !== 'failed' || tournament.rosterSyncStatus !== 'failed') {
        throw new ConflictError(
          'Tournament activation is already reconciling its authoritative roster.',
          'TOURNAMENT_RESUME_PENDING',
        );
      }
      const [reconcileJob, setupJob] = await Promise.all([
        findRosterReconcileJob(
          season,
          tournament.id,
          true,
          tournament.setupProgressUpdatedAt ?? undefined,
        ),
        findSetupJob(season, tournament.id, tournament.setupProgressUpdatedAt),
      ]);
      if (!reconcileJob && !setupJob) return;
      throw new ConflictError(
        'Tournament activation is already reconciling its authoritative roster.',
        'TOURNAMENT_RESUME_PENDING',
      );
    }
  };

  const repairMissingDeletion = async (
    season: FplSeasonRef,
    tournamentId: number,
  ): Promise<void> => {
    try {
      await lifecycle.reconcileInvalidations?.(season, tournamentId);
    } catch (error) {
      // The canonical delete already committed. A retry should still return
      // the stable not-found contract when Redis remains unavailable; the
      // durable outbox will be picked up by the maintenance worker.
      logWarn('Unable to reconcile My FPL invalidation after missing tournament', {
        tournamentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      const current = await assertCanManage(season, tournamentId, payload);
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
        current.adminEntryId,
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
      const current = await assertCanManage(season, tournamentId, payload);
      if (current.state === 'finished') {
        throw new ConflictError('Finished tournaments cannot be resumed.', 'TOURNAMENT_FINISHED');
      }
      // An inactive tournament can still carry a processing marker for a queued
      // resume. Run the pause update again so the owner's newer pause clears
      // that marker and markReadyAndResume cannot reactivate it later.
      if (current.state === payload.state && payload.state !== 'inactive') return current;

      if (payload.state === 'inactive') {
        let acceptedResume = false;
        if (
          current.rosterMode === 'official_sync' &&
          current.state === 'inactive' &&
          current.rosterSyncStatus === 'failed' &&
          current.setupStatus === 'failed' &&
          current.setupError != null
        ) {
          const [reconcileJob, setupJob] = await Promise.all([
            findRosterReconcileJob(
              season,
              tournamentId,
              true,
              current.setupProgressUpdatedAt ?? undefined,
            ),
            findSetupJob(season, tournamentId, current.setupProgressUpdatedAt),
          ]);
          acceptedResume = Boolean(reconcileJob || setupJob);
        }
        const paused = await scopeRunner(
          {
            queueName: 'tournament-management',
            jobName: 'tournament-pause',
            tournamentId,
            scopes: [tournamentSetupLifecycleScope(tournamentId)],
          },
          async () => {
            const lockedCurrent = await repository.findById(season, tournamentId);
            if (!lockedCurrent) {
              throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
            }
            if (!canManageTournament(lockedCurrent, payload)) {
              throw new ForbiddenError(
                'Only the tournament administrator can manage this tournament.',
                'TOURNAMENT_ADMIN_REQUIRED',
              );
            }

            let settleResume = false;
            if (
              lockedCurrent.rosterMode === 'official_sync' &&
              lockedCurrent.state === 'inactive' &&
              lockedCurrent.rosterSyncStatus === 'failed' &&
              lockedCurrent.setupStatus === 'failed' &&
              lockedCurrent.setupError != null
            ) {
              if (
                lockedCurrent.updatedAt !== current.updatedAt ||
                lockedCurrent.setupProgressUpdatedAt !== current.setupProgressUpdatedAt ||
                lockedCurrent.rosterSyncStatus !== current.rosterSyncStatus ||
                lockedCurrent.setupStatus !== current.setupStatus ||
                lockedCurrent.setupError !== current.setupError
              ) {
                throw new ConflictError(
                  'Tournament state changed while pause was checking queued work.',
                  'TOURNAMENT_STATE_CHANGED',
                );
              }
              settleResume = acceptedResume;
            }

            return repository.updateStateOwned(
              season,
              tournamentId,
              lockedCurrent.adminEntryId,
              'inactive',
              { settleResume },
            );
          },
        );
        if (!paused) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
        return paused;
      }

      const handoff = await scopeRunner(
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
          if (!canManageTournament(lockedCurrent, payload)) {
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
            await assertRosterBoundary(season);
            // Publish the cancellable intent before queueing. A newer pause
            // changes this marker back to ready, so a queued worker can never
            // reactivate a tournament after the owner has paused it.
            const resumeMarker = await rosterRepository.markResumeProcessingWithMarker(
              season,
              tournamentId,
            );
            const owner = await rosterRepository.findById(season, tournamentId);
            return async () => {
              try {
                await enqueueRosterReconcile(season, tournamentId, 'manual', {
                  resumeAfterSetup: true,
                  resumeMarker,
                  allowInactive: true,
                });
              } catch (error) {
                const accepted = await findRosterReconcileJob(
                  season,
                  tournamentId,
                  true,
                  resumeMarker,
                ).catch(() => null);
                if (accepted) return;
                const message =
                  error instanceof Error ? error.message : 'Unable to enqueue resume.';
                await scopeRunner(
                  {
                    queueName: 'tournament-management',
                    jobName: 'tournament-resume-failure',
                    tournamentId,
                    scopes: [tournamentSetupLifecycleScope(tournamentId)],
                  },
                  async () => {
                    const currentOwner = await rosterRepository.findById(season, tournamentId, {
                      forUpdate: true,
                    });
                    if (
                      !owner ||
                      !currentOwner ||
                      !ownsTournamentRosterExecution(currentOwner, owner)
                    )
                      return;
                    await rosterRepository.markSyncFailed(season, tournamentId, message);
                    await infoRepository.markSetupResult(season, tournamentId, 'failed', message);
                  },
                );
                throw error;
              }
            };
          } else {
            await requestSnapshotTournamentResume(tournamentId, {
              enqueue: (id, source, options) => enqueueSnapshotSetup(season, id, source, options),
              markResumeProcessing: (id) => rosterRepository.markResumeProcessing(season, id),
              markRosterFailed: (id, message) =>
                rosterRepository.markSyncFailed(season, id, message),
              markSetupFailed: (id, message) =>
                infoRepository.markSetupResult(season, id, 'failed', message),
            });
          }
          return undefined;
        },
      );
      await handoff?.();
      return (await repository.findById(season, tournamentId)) ?? current;
    },

    setRosterMode: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = rosterModeSchema.parse(input);
      const prepared = await scopeRunner(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-roster-mode',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertCanManage(season, tournamentId, payload);
          if (current.state === 'finished') {
            throw new ConflictError(
              'Finished tournaments cannot enable roster synchronization.',
              'TOURNAMENT_FINISHED',
            );
          }
          const eligible = isOfficialRosterSyncEligible(current);
          if (!eligible) {
            throw new ConflictError(
              'This tournament format cannot use official roster synchronization.',
              'TOURNAMENT_ROSTER_MODE_INELIGIBLE',
            );
          }
          if (current.rosterMode === payload.rosterMode && current.rosterSyncStatus !== 'failed') {
            const needsReconcile =
              current.state === 'active' &&
              current.rosterMode === 'official_sync' &&
              current.rosterSyncStatus === 'pending';
            return {
              tournament: current,
              needsReconcile,
              owner: needsReconcile ? await rosterRepository.findById(season, tournamentId) : null,
            };
          }
          if (current.state === 'active') {
            // Do not persist an opt-in that cannot be reconciled at the current
            // gameweek boundary. The check happens before the mode mutation.
            await assertRosterBoundary(season);
          }
          const updated = await repository.updateRosterModeOwned(
            season,
            tournamentId,
            current.adminEntryId,
            payload.rosterMode,
          );
          if (!updated) throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
          const needsReconcile =
            updated.state === 'active' && updated.rosterMode === 'official_sync';
          return {
            tournament: updated,
            needsReconcile,
            owner: needsReconcile ? await rosterRepository.findById(season, tournamentId) : null,
          };
        },
      );
      if (prepared.needsReconcile) {
        const expectedProgressMarker = prepared.owner?.setupProgressUpdatedAt ?? null;
        try {
          const existing = await findRosterReconcileJob(
            season,
            tournamentId,
            false,
            undefined,
            expectedProgressMarker,
          );
          if (!existing)
            await enqueueRosterReconcile(season, tournamentId, 'manual', {
              settleBoundaryFailure: true,
              expectedProgressMarker,
            });
        } catch (error) {
          const accepted = await findRosterReconcileJob(
            season,
            tournamentId,
            false,
            undefined,
            expectedProgressMarker,
          ).catch(() => null);
          if (!accepted) {
            await scopeRunner(
              {
                queueName: 'tournament-management',
                jobName: 'tournament-roster-mode-failure',
                tournamentId,
                scopes: [tournamentSetupLifecycleScope(tournamentId)],
              },
              async () => {
                const owner = await rosterRepository.findById(season, tournamentId, {
                  forUpdate: true,
                });
                if (
                  !owner ||
                  owner.state !== 'active' ||
                  owner.rosterMode !== 'official_sync' ||
                  owner.rosterSyncStatus !== 'pending' ||
                  owner.setupProgressUpdatedAt !== expectedProgressMarker ||
                  owner.executionId !== prepared.owner?.executionId
                )
                  return;
                await rosterRepository.markSyncFailed(
                  season,
                  tournamentId,
                  error instanceof Error
                    ? error.message
                    : 'Unable to enqueue roster reconciliation.',
                );
              },
            );
            throw error;
          }
        }
      }
      return (await repository.findById(season, tournamentId)) ?? prepared.tournament;
    },

    retrySetup: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = tournamentOwnerSchema.parse(input);
      return scopeRunner(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-setup-retry',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertCanManage(season, tournamentId, payload);
          await assertNoPendingOfficialResume(season, current);
          return requeueSetup(season, tournamentId);
        },
      );
    },

    retryRoster: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = tournamentOwnerSchema.parse(input);
      const observed = await assertCanManage(season, tournamentId, payload);
      await assertNoPendingOfficialResume(season, observed);
      const expectedProgressMarker = await scopeRunner(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-roster-retry',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        async () => {
          const current = await assertCanManage(season, tournamentId, payload);
          if (current.rosterMode !== 'official_sync') {
            throw new ValidationError(
              'Tournament roster is a fixed snapshot.',
              'TOURNAMENT_ROSTER_SNAPSHOT',
            );
          }
          if (current.state === 'finished') {
            throw new ConflictError('Tournament is already finished.', 'TOURNAMENT_FINISHED');
          }
          if (
            current.updatedAt !== observed.updatedAt ||
            current.setupProgressUpdatedAt !== observed.setupProgressUpdatedAt ||
            current.rosterSyncStatus !== observed.rosterSyncStatus ||
            current.setupStatus !== observed.setupStatus
          ) {
            throw new ConflictError(
              'Tournament state changed while retry was checking queued work.',
              'TOURNAMENT_STATE_CHANGED',
            );
          }
          await assertRosterBoundary(season);
          const rosterState = await rosterRepository.findById(season, tournamentId);
          return rosterState?.setupProgressUpdatedAt ?? null;
        },
      );
      const job = await enqueueRosterReconcile(season, tournamentId, 'manual', {
        allowInactive: true,
        settleBoundaryFailure: true,
        expectedProgressMarker,
      });
      return {
        tournamentId,
        changed: false,
        queued: true,
        operationId: job.id ?? null,
        status: 'pending' as const,
      };
    },

    deleteTournament: async (tournamentId: number, input: unknown) => {
      const season = await getSeason();
      const payload = deleteTournamentSchema.parse(input);
      const current = await repository.findById(season, tournamentId);
      if (!current) {
        await repairMissingDeletion(season, tournamentId);
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      if (!canManageTournament(current, payload)) {
        throw new ForbiddenError(
          'Only the tournament administrator can delete this tournament.',
          'TOURNAMENT_ADMIN_REQUIRED',
        );
      }
      const result = lifecycle.deleteOwned
        ? await lifecycle.deleteOwned(season, tournamentId, current.adminEntryId)
        : await repository.deleteOwned(season, tournamentId, current.adminEntryId);
      if (result.status === 'not_found') {
        await repairMissingDeletion(season, tournamentId);
        throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
      }
      if (result.status === 'forbidden') {
        throw new ForbiddenError(
          'Only the tournament administrator can delete this tournament.',
          'TOURNAMENT_ADMIN_REQUIRED',
        );
      }
      if (result.invalidationOutboxIds && result.invalidationOutboxIds.length > 0) {
        try {
          const dispatchResult = await (
            lifecycle.dispatchInvalidations ?? dispatchMyFplSnapshotInvalidationOutbox
          )({
            outboxIds: result.invalidationOutboxIds,
            limit: result.invalidationOutboxIds.length,
          });
          if (dispatchResult.failed > 0 || dispatchResult.remaining > 0) {
            logWarn('Tournament deleted with pending My FPL Redis invalidation', {
              tournamentId,
              failed: dispatchResult.failed,
              remaining: dispatchResult.remaining,
            });
          }
        } catch (error) {
          // PostgreSQL is authoritative and the delete transaction has
          // committed. Redis cleanup is durable and will be retried by the
          // five-minute maintenance job, so it must not turn DELETE into a
          // misleading 500 response.
          logWarn('Tournament deleted but My FPL Redis invalidation dispatch failed', {
            tournamentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        await lifecycle.refreshViews?.();
      } catch (error) {
        // The canonical deletion and durable invalidation receipt have
        // already committed. A derived reporting refresh must not turn that
        // success into a misleading 500 response. Retry the targeted repair
        // once and let later maintenance/retries converge if it is unavailable.
        logWarn('Tournament deleted but reporting view refresh failed', {
          tournamentId,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await lifecycle.repairDeletedViews?.(tournamentId);
        } catch (repairError) {
          logWarn('Tournament deleted with reporting view repair still pending', {
            tournamentId,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
        }
      }
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
    dispatchInvalidations: dispatchMyFplSnapshotInvalidationOutbox,
    reconcileInvalidations: async (season, tournamentId) =>
      dispatchMyFplSnapshotInvalidationOutbox({
        seasonId: season.seasonId,
        tournamentId,
        limit: 50,
      }),
    repairDeletedViews: repairDeletedTournamentMaterializedViews,
    deleteOwned: async (season, tournamentId, adminEntryId) => {
      const { cancelWaitingTournamentSetupJobs } = await import('../jobs/tournament-setup.jobs');
      const { cancelWaitingTournamentRosterReconcileJobs } = await import(
        '../jobs/tournament-sync.jobs'
      );
      const { tournamentSetupLifecycleScope } = await import('../domain/mutation-scope');
      const { withMutationScopes } = await import('../utils/mutation-scopes');
      const result = await withMutationScopes(
        {
          queueName: 'tournament-management',
          jobName: 'tournament-delete',
          tournamentId,
          scopes: [tournamentSetupLifecycleScope(tournamentId)],
        },
        () => tournamentManagementRepository.deleteOwned(season, tournamentId, adminEntryId),
      );
      if (result.status === 'deleted') {
        // Canonical deletion is committed. Workers that already started, or
        // are queued concurrently, recheck existence and settle as no-ops.
        const { cancelTournamentRepairJobs } = await import('../jobs/tournament-repair.jobs');
        const cleanup = await Promise.allSettled([
          cancelWaitingTournamentSetupJobs(tournamentId),
          cancelTournamentRepairJobs(tournamentId),
          cancelWaitingTournamentRosterReconcileJobs(tournamentId),
        ]);
        const failures = cleanup.filter((item) => item.status === 'rejected').length;
        if (failures > 0) {
          logWarn('Tournament deleted with pending queue cleanup', { tournamentId, failures });
        }
      }
      return result;
    },
  },
);
