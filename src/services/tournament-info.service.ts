import { fplClient } from '../clients/fpl';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

async function fetchLeagueName(leagueId: number, leagueType: 'classic' | 'h2h') {
  const standings =
    leagueType === 'h2h'
      ? await fplClient.getLeagueH2HStandings(leagueId, 1)
      : await fplClient.getLeagueClassicStandings(leagueId, 1);
  return standings.league?.name ?? null;
}

export async function syncTournamentInfo(options?: { concurrency?: number }): Promise<{
  total: number;
  updated: number;
  skipped: number;
  errors: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  logInfo('Starting tournament info sync');

  const tournaments = await tournamentInfoRepository.findAllNames();
  if (tournaments.length === 0) {
    logInfo('No tournament info records found');
    return {
      total: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const leagueNameMap = new Map<string, string>();
  const leagueRequests = Array.from(
    new Map(
      tournaments.map((tournament) => [
        `${tournament.leagueType}:${tournament.leagueId}`,
        { leagueId: tournament.leagueId, leagueType: tournament.leagueType },
      ]),
    ).values(),
  );
  const outcomes = await mapWithConcurrency(leagueRequests, concurrency, async (request) => {
    const key = `${request.leagueType}:${request.leagueId}`;
    try {
      const name = await fetchLeagueName(request.leagueId, request.leagueType);
      if (!name?.trim()) {
        throw new Error('League response did not contain a name');
      }
      leagueNameMap.set(key, name.trim());
      return true;
    } catch (error) {
      logError('Failed to fetch tournament league name', error, {
        leagueId: request.leagueId,
        leagueType: request.leagueType,
      });
      return false;
    }
  });
  const errors = outcomes.filter((success) => !success).length;

  const updates = tournaments
    .map((tournament) => {
      const key = `${tournament.leagueType}:${tournament.leagueId}`;
      const fetchedName = leagueNameMap.get(key);
      if (!fetchedName) {
        return null;
      }
      if (fetchedName.trim() === tournament.sourceLeagueName?.trim()) {
        return null;
      }
      return { id: tournament.id, sourceLeagueName: fetchedName };
    })
    .filter((update): update is { id: number; sourceLeagueName: string } => Boolean(update));

  const updated = await tournamentInfoRepository.updateSourceLeagueNames(updates);
  const skipped = tournaments.length - updated;

  logInfo('Tournament info sync completed', {
    total: tournaments.length,
    updated,
    skipped,
    errors,
  });

  if (errors > 0) {
    throw new IncompleteDataSyncError(
      'Tournament source-league names did not converge',
      leagueRequests.length,
      0,
      leagueRequests.length - errors,
      errors,
    );
  }

  return {
    total: tournaments.length,
    updated,
    skipped,
    errors,
    requiredUnits: leagueRequests.length,
    reusedUnits: 0,
    succeededUnits: leagueRequests.length,
    failedUnits: 0,
  };
}
