import { enqueueLeagueEventPicks, enqueueLeagueEventResults } from '../jobs/league-sync.jobs';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { logError, logInfo } from '../utils/logger';
import { syncLeagueEventPicksByTournament } from './league-event-picks.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';

/**
 * Enqueue per-tournament jobs for league event picks (coordinator fan-out).
 */
export async function enqueuePicksPerTournament(eventId: number) {
  logInfo('Enqueueing per-tournament picks jobs', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for picks sync', { eventId });
    return { enqueued: 0 };
  }

  const results = await Promise.allSettled(
    tournaments.map((tournament) =>
      enqueueLeagueEventPicks(eventId, 'cascade', { tournamentId: tournament.id }),
    ),
  );

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logInfo('Per-tournament picks jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logError('Failed to enqueue picks job for tournament', result.reason, {
        eventId,
        tournamentId: tournaments[index].id,
      });
    }
  });

  return { enqueued: successful };
}

/**
 * Enqueue per-tournament jobs for league event results (coordinator fan-out).
 */
export async function enqueueResultsPerTournament(eventId: number) {
  logInfo('Enqueueing per-tournament results jobs', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments for results sync', { eventId });
    return { enqueued: 0 };
  }

  const results = await Promise.allSettled(
    tournaments.map((tournament) =>
      enqueueLeagueEventResults(eventId, 'cascade', { tournamentId: tournament.id }),
    ),
  );

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;

  logInfo('Per-tournament results jobs enqueued', {
    eventId,
    total: tournaments.length,
    successful,
    failed,
  });

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logError('Failed to enqueue results job for tournament', result.reason, {
        eventId,
        tournamentId: tournaments[index].id,
      });
    }
  });

  return { enqueued: successful };
}

export async function processLeagueEventPicksJob(eventId: number, tournamentId?: number) {
  if (tournamentId) {
    return syncLeagueEventPicksByTournament(tournamentId, eventId);
  }
  return enqueuePicksPerTournament(eventId);
}

export async function processLeagueEventResultsJob(eventId: number, tournamentId?: number) {
  if (tournamentId) {
    return syncLeagueEventResultsByTournament(tournamentId, eventId);
  }
  return enqueueResultsPerTournament(eventId);
}
