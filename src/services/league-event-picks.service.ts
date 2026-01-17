import { fplClient } from '../clients/fpl';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { logError, logInfo } from '../utils/logger';
import { syncEntryEventPicks } from './entries.service';

const DEFAULT_CONCURRENCY = 5;

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
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

async function fetchLeagueEntryIds(tournament: TournamentInfoSummary): Promise<number[]> {
  const maxEntries = tournament.totalTeamNum > 0 ? tournament.totalTeamNum : undefined;
  const entryIds: number[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const response =
      tournament.leagueType === 'classic'
        ? await fplClient.getLeagueClassicStandings(tournament.leagueId, page)
        : await fplClient.getLeagueH2HStandings(tournament.leagueId, page);

    const pageEntries = response.standings.results.map((result) => result.entry).filter(Boolean);
    entryIds.push(...pageEntries);

    if (maxEntries && entryIds.length >= maxEntries) {
      break;
    }

    hasNext = response.standings.has_next;
    page += 1;
  }

  const uniqueEntryIds = uniqueNumbers(entryIds);
  if (maxEntries) {
    return uniqueEntryIds.slice(0, maxEntries);
  }

  return uniqueEntryIds;
}

async function resolveTournamentEntries(tournament: TournamentInfoSummary): Promise<number[]> {
  const storedEntries = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
  if (storedEntries.length > 0) {
    return uniqueNumbers(storedEntries);
  }

  return fetchLeagueEntryIds(tournament);
}

export async function syncLeagueEventPicksByTournament(
  tournamentId: number,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  tournamentId: number;
  eventId: number;
  totalEntries: number;
  synced: number;
  skipped: number;
  errors: number;
}> {
  logInfo('Starting league event picks sync for tournament', { tournamentId, eventId });

  const tournament = await tournamentInfoRepository.findById(tournamentId);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  const entryIds = await resolveTournamentEntries(tournament);
  logInfo('Resolved tournament entries for league picks', {
    eventId,
    tournamentId,
    leagueId: tournament.leagueId,
    leagueType: tournament.leagueType,
    entries: entryIds.length,
  });

  const existingEntryIds = await entryEventPicksRepository.findEntryIdsByEvent(eventId, entryIds);
  const existingSet = new Set(existingEntryIds);
  const entriesToSync = entryIds.filter((entryId) => !existingSet.has(entryId));
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  if (entriesToSync.length === 0) {
    logInfo('League event picks already synced for tournament', {
      eventId,
      tournamentId,
      totalEntries: entryIds.length,
      skipped: existingEntryIds.length,
    });
    return {
      tournamentId,
      eventId,
      totalEntries: entryIds.length,
      synced: 0,
      skipped: existingEntryIds.length,
      errors: 0,
    };
  }

  const results = await mapWithConcurrency(entriesToSync, concurrency, async (entryId) => {
    try {
      await syncEntryEventPicks(entryId, eventId);
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      logError('Failed to sync league entry picks', error, { eventId, entryId, tournamentId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const synced = results.filter((result) => result.success).length;
  const errors = results.length - synced;

  logInfo('League event picks sync completed for tournament', {
    eventId,
    tournamentId,
    totalEntries: entryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
  });

  return {
    tournamentId,
    eventId,
    totalEntries: entryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
  };
}
