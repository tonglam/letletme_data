import { fplClient } from '../clients/fpl';
import {
  tournamentInfoRepository,
  type TournamentInfoNameSummary,
} from '../repositories/tournament-infos';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await handler(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fetchLeagueName(leagueId: number, leagueType: 'classic' | 'h2h') {
  const standings =
    leagueType === 'h2h'
      ? await fplClient.getLeagueH2HStandings(leagueId, 1)
      : await fplClient.getLeagueClassicStandings(leagueId, 1);
  return standings.league?.name ?? null;
}

export async function syncTournamentInfo(
  options?: { concurrency?: number },
): Promise<{ total: number; updated: number; skipped: number; errors: number }> {
  logInfo('Starting tournament info sync');

  const tournaments = await tournamentInfoRepository.findAllNames();
  if (tournaments.length === 0) {
    logInfo('No tournament info records found');
    return { total: 0, updated: 0, skipped: 0, errors: 0 };
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
  let errors = 0;

  await mapWithConcurrency(leagueRequests, concurrency, async (request) => {
    const key = `${request.leagueType}:${request.leagueId}`;
    try {
      const name = await fetchLeagueName(request.leagueId, request.leagueType);
      if (name) {
        leagueNameMap.set(key, name);
      }
      return null;
    } catch (error) {
      errors += 1;
      logError('Failed to fetch tournament league name', error, {
        leagueId: request.leagueId,
        leagueType: request.leagueType,
      });
      return null;
    }
  });

  const updates = tournaments
    .map((tournament) => {
      const key = `${tournament.leagueType}:${tournament.leagueId}`;
      const fetchedName = leagueNameMap.get(key);
      if (!fetchedName) {
        return null;
      }
      if (normalizeName(fetchedName) === normalizeName(tournament.name)) {
        return null;
      }
      return { id: tournament.id, name: fetchedName };
    })
    .filter((update): update is { id: number; name: string } => Boolean(update));

  const updated = await tournamentInfoRepository.updateNames(updates);
  const skipped = tournaments.length - updated;

  logInfo('Tournament info sync completed', {
    total: tournaments.length,
    updated,
    skipped,
    errors,
  });

  return { total: tournaments.length, updated, skipped, errors };
}
