import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { syncLeagueEventPicksByTournament } from './league-event-picks.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';

/**
 * Synchronize every active tournament inside one durable coordinator attempt.
 * The root scheduler obligation therefore represents canonical convergence,
 * not merely successful child enqueue acknowledgements.
 */
// Every tournament in one event acquires the same entry/league event mutation
// scopes. Parallel fan-out therefore cannot perform canonical writes in
// parallel; it only creates 120-second lock waiters while the largest league
// is still fetching and persisting its entries. Keep one tournament in flight
// per coordinator and leave the remaining database pool capacity available to
// live/core publication work.
export const LEAGUE_FANOUT_CONCURRENCY = 1;

type LeagueTournamentSyncResult = Readonly<{
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}>;

type TournamentSyncOutcome =
  | Readonly<{ success: true; result: LeagueTournamentSyncResult }>
  | Readonly<{ success: false; tournamentId: number; reason: unknown }>;

export async function syncActiveLeagueTournaments(input: {
  season: FplSeasonRef;
  eventId: number;
  label: 'picks' | 'results';
  syncTournament: (tournamentId: number) => Promise<LeagueTournamentSyncResult>;
  findActiveTournaments?: (season: FplSeasonRef) => Promise<readonly Readonly<{ id: number }>[]>;
}): Promise<{
  tournaments: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  const findActiveTournaments = input.findActiveTournaments ?? tournamentInfoRepository.findActive;
  const tournaments = await findActiveTournaments(input.season);
  if (tournaments.length === 0) {
    logInfo(`No active tournaments for league ${input.label} sync`, { eventId: input.eventId });
    return {
      tournaments: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const outcomes = await mapWithConcurrency(
    tournaments,
    LEAGUE_FANOUT_CONCURRENCY,
    async (tournament): Promise<TournamentSyncOutcome> => {
      try {
        return { success: true, result: await input.syncTournament(tournament.id) };
      } catch (reason) {
        return { success: false, tournamentId: tournament.id, reason };
      }
    },
  );

  const successes = outcomes.filter(
    (outcome): outcome is Extract<TournamentSyncOutcome, { success: true }> => outcome.success,
  );
  const failures = outcomes.filter(
    (outcome): outcome is Extract<TournamentSyncOutcome, { success: false }> => !outcome.success,
  );
  const summary = successes.reduce(
    (total, outcome) => ({
      requiredUnits: total.requiredUnits + outcome.result.requiredUnits,
      reusedUnits: total.reusedUnits + outcome.result.reusedUnits,
      succeededUnits: total.succeededUnits + outcome.result.succeededUnits,
      failedUnits: total.failedUnits + outcome.result.failedUnits,
    }),
    { requiredUnits: 0, reusedUnits: 0, succeededUnits: 0, failedUnits: 0 },
  );

  for (const failure of failures) {
    if (failure.reason instanceof IncompleteDataSyncError) {
      summary.requiredUnits += failure.reason.requiredUnits;
      summary.reusedUnits += failure.reason.reusedUnits;
      summary.succeededUnits += failure.reason.succeededUnits;
      summary.failedUnits += failure.reason.failedUnits;
    } else {
      summary.requiredUnits += 1;
      summary.failedUnits += 1;
    }
    logError(`Failed to sync league ${input.label} for tournament`, failure.reason, {
      eventId: input.eventId,
      tournamentId: failure.tournamentId,
    });
  }

  logInfo(`League ${input.label} coordinator completed`, {
    eventId: input.eventId,
    total: tournaments.length,
    successful: successes.length,
    failed: failures.length,
    ...summary,
  });

  if (failures.length > 0 || summary.failedUnits > 0) {
    throw new IncompleteDataSyncError(
      `League ${input.label} did not converge for every active tournament`,
      summary.requiredUnits,
      summary.reusedUnits,
      summary.succeededUnits,
      summary.failedUnits,
    );
  }

  return {
    tournaments: tournaments.length,
    ...summary,
  };
}

async function syncPicksAcrossTournaments(season: FplSeasonRef, eventId: number, runId?: string) {
  return syncActiveLeagueTournaments({
    season,
    eventId,
    label: 'picks',
    syncTournament: (tournamentId) =>
      withMutationScopes(
        {
          queueName: 'league-sync',
          jobName: 'league-event-picks',
          jobId: `${runId ?? 'coordinator'}:t${tournamentId}`,
          eventId,
          tournamentId,
        },
        () => syncLeagueEventPicksByTournament(season, tournamentId, eventId),
      ),
  });
}

async function syncResultsAcrossTournaments(
  season: FplSeasonRef,
  eventId: number,
  context?: { runId?: string; freshAfter?: string },
) {
  return syncActiveLeagueTournaments({
    season,
    eventId,
    label: 'results',
    syncTournament: (tournamentId) =>
      withMutationScopes(
        {
          queueName: 'league-sync',
          jobName: 'league-event-results',
          jobId: `${context?.runId ?? 'coordinator'}:t${tournamentId}`,
          eventId,
          tournamentId,
        },
        () =>
          syncLeagueEventResultsByTournament(season, tournamentId, eventId, {
            freshAfter: context?.freshAfter,
          }),
      ),
  });
}

export async function processLeagueEventPicksJob(
  season: FplSeasonRef,
  eventId: number,
  tournamentId?: number,
  runId?: string,
) {
  if (tournamentId) {
    return syncLeagueEventPicksByTournament(season, tournamentId, eventId);
  }
  return syncPicksAcrossTournaments(season, eventId, runId);
}

export async function processLeagueEventResultsJob(
  season: FplSeasonRef,
  eventId: number,
  tournamentId?: number,
  context?: { runId?: string; freshAfter?: string },
) {
  if (tournamentId) {
    return syncLeagueEventResultsByTournament(season, tournamentId, eventId, {
      freshAfter: context?.freshAfter,
    });
  }
  return syncResultsAcrossTournaments(season, eventId, context);
}
