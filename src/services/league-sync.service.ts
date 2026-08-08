import { enqueueLeagueEventPicks, enqueueLeagueEventResults } from '../jobs/league-sync.jobs';
import { leagueChildJobId } from '../domain/league-sync';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { syncLeagueEventPicksByTournament } from './league-event-picks.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';

/**
 * Enqueue per-tournament jobs for league event picks (coordinator fan-out).
 */
export const LEAGUE_FANOUT_CONCURRENCY = 10;

type FanoutResult = { success: true } | { success: false; tournamentId: number; reason: unknown };

export async function enqueuePicksPerTournament(eventId: number, runId?: string) {
  logInfo('Enqueueing per-tournament picks jobs', { eventId, runId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for picks sync', { eventId });
    return {
      enqueued: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const results = await mapWithConcurrency(
    tournaments,
    LEAGUE_FANOUT_CONCURRENCY,
    async (tournament): Promise<FanoutResult> => {
      try {
        await enqueueLeagueEventPicks(eventId, 'cascade', {
          tournamentId: tournament.id,
          jobId: leagueChildJobId('league-event-picks', eventId, tournament.id, runId),
          runId,
        });
        return { success: true };
      } catch (reason) {
        return { success: false, tournamentId: tournament.id, reason };
      }
    },
  );

  const successful = results.filter((result) => result.success).length;
  const failures = results.filter(
    (result): result is Extract<FanoutResult, { success: false }> => !result.success,
  );
  const failed = failures.length;

  logInfo('Per-tournament picks jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  if (failed > 0) {
    failures.forEach(({ tournamentId, reason }) => {
      logError('Failed to enqueue picks job for tournament', reason, {
        eventId,
        tournamentId,
      });
    });
    throw new IncompleteDataSyncError(
      'League picks cascade did not enqueue every tournament',
      tournaments.length,
      0,
      successful,
      failed,
    );
  }

  return {
    enqueued: successful,
    requiredUnits: tournaments.length,
    reusedUnits: 0,
    succeededUnits: successful,
    failedUnits: 0,
  };
}

/**
 * Enqueue per-tournament jobs for league event results (coordinator fan-out).
 */
export async function enqueueResultsPerTournament(eventId: number, runId?: string) {
  logInfo('Enqueueing per-tournament results jobs', { eventId, runId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for results sync', { eventId });
    return {
      enqueued: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const results = await mapWithConcurrency(
    tournaments,
    LEAGUE_FANOUT_CONCURRENCY,
    async (tournament): Promise<FanoutResult> => {
      try {
        await enqueueLeagueEventResults(eventId, 'cascade', {
          tournamentId: tournament.id,
          jobId: leagueChildJobId('league-event-results', eventId, tournament.id, runId),
          runId,
        });
        return { success: true };
      } catch (reason) {
        return { success: false, tournamentId: tournament.id, reason };
      }
    },
  );

  const successful = results.filter((result) => result.success).length;
  const failures = results.filter(
    (result): result is Extract<FanoutResult, { success: false }> => !result.success,
  );
  const failed = failures.length;

  logInfo('Per-tournament results jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  if (failed > 0) {
    failures.forEach(({ tournamentId, reason }) => {
      logError('Failed to enqueue results job for tournament', reason, {
        eventId,
        tournamentId,
      });
    });
    throw new IncompleteDataSyncError(
      'League results cascade did not enqueue every tournament',
      tournaments.length,
      0,
      successful,
      failed,
    );
  }

  return {
    enqueued: successful,
    requiredUnits: tournaments.length,
    reusedUnits: 0,
    succeededUnits: successful,
    failedUnits: 0,
  };
}

export async function processLeagueEventPicksJob(
  eventId: number,
  tournamentId?: number,
  runId?: string,
) {
  if (tournamentId) {
    return syncLeagueEventPicksByTournament(tournamentId, eventId);
  }
  return enqueuePicksPerTournament(eventId, runId);
}

export async function processLeagueEventResultsJob(
  eventId: number,
  tournamentId?: number,
  context?: { runId?: string; freshAfter?: string },
) {
  if (tournamentId) {
    return syncLeagueEventResultsByTournament(tournamentId, eventId, {
      freshAfter: context?.freshAfter,
    });
  }
  return enqueueResultsPerTournament(eventId, context?.runId);
}
