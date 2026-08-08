import { eventRepository } from '../repositories/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import {
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../domain/mutation-scope';
import { diffTournamentRoster, getTournamentBackfillWindow } from '../domain/tournament';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../queues/entry-sync.queue';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { mapWithConcurrency } from '../utils/async';
import { logError, logInfo } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import {
  ensureTournamentCoreResults,
  syncTournamentEntryDetails,
} from './tournament-backfill.service';
import { syncEntryTransferHistories } from './tournament-event-results.service';
import { fetchLeagueParticipants } from './tournament-league-members.service';
import { refreshTournamentEntryEventSummariesMaterializedView } from './tournament-materialized-views.service';
import { refreshTournamentSelectionStatsMaterializedView } from './tournament-selection-stats.service';

function officialLeagueUrl(leagueId: number, leagueType: 'classic' | 'h2h'): string {
  const suffix = leagueType === 'classic' ? 'c' : 'h';
  return `https://fantasy.premierleague.com/leagues/${leagueId}/standings/${suffix}`;
}

async function assertPreGameweekBoundary(season: FplSeasonRef): Promise<void> {
  const currentEvent = await eventRepository.findCurrent(season);
  if (currentEvent && !currentEvent.dataChecked) {
    throw new ConflictError(
      'Tournament membership is frozen while a gameweek is active.',
      'TOURNAMENT_ROSTER_FROZEN',
    );
  }
}

export async function assertTournamentRosterPreGameweekBoundary(
  season: FplSeasonRef,
): Promise<void> {
  await assertPreGameweekBoundary(season);
}

export type TournamentRosterReconcileResult = {
  tournamentId: number;
  changed: boolean;
  addedEntryIds: number[];
  removedEntryIds: number[];
  participantCount: number;
  automaticallyPaused: boolean;
};

async function reconcileTournamentRosterUnlocked(
  season: FplSeasonRef,
  tournamentId: number,
  options?: { allowInactive?: boolean; resumeAfterSetup?: boolean },
): Promise<TournamentRosterReconcileResult> {
  await assertPreGameweekBoundary(season);
  const tournament = await tournamentRosterRepository.findById(season, tournamentId);
  if (!tournament) {
    throw new NotFoundError('Tournament not found.', 'TOURNAMENT_NOT_FOUND');
  }
  if (tournament.rosterMode !== 'official_sync') {
    throw new ValidationError(
      'Tournament roster is a fixed snapshot.',
      'TOURNAMENT_ROSTER_SNAPSHOT',
    );
  }
  if (tournament.state === 'finished') {
    throw new ConflictError('Tournament is already finished.', 'TOURNAMENT_FINISHED');
  }
  if (tournament.state === 'inactive' && !options?.allowInactive) {
    throw new ConflictError('Paused tournaments are not synchronized.', 'TOURNAMENT_PAUSED');
  }

  if (options?.resumeAfterSetup) {
    // This runs inside the per-tournament lifecycle lock. The resume marker is
    // therefore written only after any prior setup attempt has finished its
    // canonical transition, never before waiting on that worker.
    await tournamentRosterRepository.markResumeProcessing(season, tournamentId);
  } else {
    await tournamentRosterRepository.markSyncProcessing(season, tournamentId);
  }
  let setupEnqueueRequired = false;
  try {
    const source = await fetchLeagueParticipants(
      officialLeagueUrl(tournament.leagueId, tournament.leagueType),
    );
    const existingIds = await tournamentRosterRepository.findEntryIds(season, tournamentId);
    const sourceIds = source.participants.map((participant) => Number(participant.id));
    const { addedEntryIds, removedEntryIds } = diffTournamentRoster(existingIds, sourceIds);
    const finalizedEvent = await eventRepository.findLatestFinalized(season);
    const window = getTournamentBackfillWindow(tournament, finalizedEvent?.id ?? null);

    if (addedEntryIds.length > 0) {
      const targetEventId = window?.endEventId ?? 0;
      const entryIssues = await syncTournamentEntryDetails(season, addedEntryIds, {
        targetEventId,
      });
      if (entryIssues.length > 0) {
        const failedCount = entryIssues.reduce(
          (count, issue) => count + (issue.failedEntries?.length ?? 0),
          0,
        );
        throw new Error(`Unable to prepare ${failedCount} new tournament entrant(s)`);
      }

      if (window) {
        await ensureTournamentCoreResults(season, addedEntryIds, window);
      }
      const transferEntryIds = await entryEventTransfersRepository.findEntryIdsNeedingSync(
        season,
        addedEntryIds,
        targetEventId,
      );
      const transfers = await syncEntryTransferHistories(season, transferEntryIds, targetEventId, {
        concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
      });
      if (transfers.errors > 0) {
        throw new Error(
          `Unable to prepare transfer history for ${transfers.errors} new entrant(s)`,
        );
      }
    }

    // The authoritative fetch and entrant backfills above intentionally happen
    // without the global structure lock. Hold it only for the short roster
    // publication transaction, which replaces tournament-owned structure rows.
    const publication = await withMutationConflictGuard(
      {
        queueName: 'tournament-roster',
        jobName: 'publish-authoritative-roster',
        tournamentId,
        // Serialize the final boundary check with the canonical events writer,
        // then keep membership frozen through the short structure transaction.
        scopes: [...tournamentSetupRebuildScopes(tournamentId), 'data-core:events'],
      },
      async () => {
        await assertPreGameweekBoundary(season);
        return tournamentRosterRepository.publishAuthoritativeRoster(
          season,
          tournament,
          source.participants,
          source.leagueName,
          {
            allowInactive: options?.allowInactive,
            resumeAfterSetup: options?.resumeAfterSetup,
          },
        );
      },
    );
    if (publication.skipped) {
      logInfo('Tournament roster publication skipped after lifecycle state changed', {
        tournamentId,
        participantCount: publication.participantCount,
      });
      return {
        tournamentId,
        changed: false,
        addedEntryIds: [],
        removedEntryIds: [],
        participantCount: publication.participantCount,
        automaticallyPaused: false,
      };
    }
    if (publication.changed) {
      await refreshTournamentSelectionStatsMaterializedView();
      await refreshTournamentEntryEventSummariesMaterializedView();
    }

    const needsSetup =
      publication.changed || options?.resumeAfterSetup || tournament.standingsReadyAt === null;
    setupEnqueueRequired = needsSetup && !publication.automaticallyPaused;
    if (setupEnqueueRequired) {
      await enqueueTournamentSetup(
        season,
        tournamentId,
        options?.resumeAfterSetup ? 'resume' : 'roster',
        {
          forceNew: true,
          // The lifecycle lock is held here. If BullMQ still reports an active
          // predecessor after the settle window, leave a distinct successor;
          // reusing it would not prove that the newly published marker is read.
          ensureSuccessorOnActive: true,
          activeSettleTimeoutMs: 2_000,
        },
      );
    }

    logInfo('Tournament roster reconciliation completed', {
      tournamentId,
      changed: publication.changed,
      addedEntryIds,
      removedEntryIds,
      participantCount: publication.participantCount,
      automaticallyPaused: publication.automaticallyPaused,
    });
    return {
      tournamentId,
      changed: publication.changed,
      addedEntryIds,
      removedEntryIds,
      participantCount: publication.participantCount,
      automaticallyPaused: publication.automaticallyPaused,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tournament roster sync failed.';
    await Promise.allSettled([
      tournamentRosterRepository.markSyncFailed(season, tournamentId, message),
      ...(options?.resumeAfterSetup || setupEnqueueRequired
        ? [tournamentInfoRepository.markSetupResult(season, tournamentId, 'failed', message)]
        : []),
    ]);
    throw error;
  }
}

export async function reconcileTournamentRoster(
  season: FplSeasonRef,
  tournamentId: number,
  options?: { allowInactive?: boolean; resumeAfterSetup?: boolean },
): Promise<TournamentRosterReconcileResult> {
  // Serialize create/setup, delete, resume, and roster retry for this one
  // tournament. This is deliberately not the global structure lock, so slow
  // FPL requests do not block unrelated tournament calculations.
  return withMutationConflictGuard(
    {
      queueName: 'tournament-roster',
      jobName: 'reconcile-authoritative-roster',
      tournamentId,
      scopes: [tournamentSetupLifecycleScope(tournamentId)],
      required: true,
    },
    () => reconcileTournamentRosterUnlocked(season, tournamentId, options),
  );
}

export async function reconcileOfficialTournamentRosters(season: FplSeasonRef): Promise<{
  total: number;
  changed: number;
  skipped: number;
  errors: number;
}> {
  try {
    await assertPreGameweekBoundary(season);
  } catch (error) {
    if (error instanceof ConflictError) {
      logInfo('Skipping official roster reconciliation during active gameweek');
      return { total: 0, changed: 0, skipped: 0, errors: 0 };
    }
    throw error;
  }

  const tournaments = await tournamentRosterRepository.findActiveOfficialSync(season);
  let changed = 0;
  let errors = 0;
  await mapWithConcurrency(tournaments, 2, async (tournament) => {
    try {
      const result = await withMutationConflictGuard(
        {
          queueName: 'tournament-roster',
          jobName: 'reconcile-authoritative-roster',
          tournamentId: tournament.id,
          scopes: [tournamentSetupLifecycleScope(tournament.id)],
          required: true,
        },
        () => reconcileTournamentRosterUnlocked(season, tournament.id),
      );
      if (result.changed) changed += 1;
    } catch (error) {
      errors += 1;
      logError('Official tournament roster reconciliation failed', error, {
        tournamentId: tournament.id,
      });
    }
  });

  return {
    total: tournaments.length,
    changed,
    skipped: tournaments.length - changed - errors,
    errors,
  };
}

export async function finishTournamentsThroughEvent(
  season: FplSeasonRef,
  eventId: number,
  targets: TournamentFinalizationTarget[],
): Promise<number> {
  return tournamentRosterRepository.finishThroughEvent(season, eventId, targets);
}
