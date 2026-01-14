import { fplClient } from '../clients/fpl';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { syncEntryEventPicks } from './entries.service';
import { logError, logInfo } from '../utils/logger';

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

export async function syncLeagueEventPicks(
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  synced: number;
  skipped: number;
  errors: number;
}> {
  logInfo('Starting league event picks sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for league event picks', { eventId });
    return { eventId, totalEntries: 0, synced: 0, skipped: 0, errors: 0 };
  }

  const entryBuckets: number[][] = [];

  for (const tournament of tournaments) {
    try {
      const entryIds = await resolveTournamentEntries(tournament);
      entryBuckets.push(entryIds);
      logInfo('Resolved tournament entries for league picks', {
        eventId,
        tournamentId: tournament.id,
        leagueId: tournament.leagueId,
        leagueType: tournament.leagueType,
        entries: entryIds.length,
      });
    } catch (error) {
      logError('Failed to resolve tournament entries for league picks', error, {
        eventId,
        tournamentId: tournament.id,
        leagueId: tournament.leagueId,
        leagueType: tournament.leagueType,
      });
    }
  }

  const allEntryIds = uniqueNumbers(entryBuckets.flat());
  if (allEntryIds.length === 0) {
    logInfo('No entries resolved for league event picks', { eventId });
    return { eventId, totalEntries: 0, synced: 0, skipped: 0, errors: 0 };
  }

  const existingEntryIds = await entryEventPicksRepository.findEntryIdsByEvent(
    eventId,
    allEntryIds,
  );
  const existingSet = new Set(existingEntryIds);
  const entriesToSync = allEntryIds.filter((entryId) => !existingSet.has(entryId));
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  if (entriesToSync.length === 0) {
    logInfo('League event picks already synced', {
      eventId,
      totalEntries: allEntryIds.length,
      skipped: existingEntryIds.length,
    });
    return {
      eventId,
      totalEntries: allEntryIds.length,
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
      logError('Failed to sync league entry picks', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const synced = results.filter((result) => result.success).length;
  const errors = results.length - synced;

  logInfo('League event picks sync completed', {
    eventId,
    totalEntries: allEntryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
  });

  return {
    eventId,
    totalEntries: allEntryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
  };
}
