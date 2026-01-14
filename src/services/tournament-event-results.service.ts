import { fplClient } from '../clients/fpl';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
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

export async function syncTournamentEventResults(
  eventId: number,
  options?: { concurrency?: number },
): Promise<{ eventId: number; totalEntries: number; synced: number; errors: number }> {
  logInfo('Starting tournament event results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event results', { eventId });
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );

  const entryIds = uniqueNumbers(entryLists.flat());
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { eventId });
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const live = await fplClient.getEventLive(eventId);
  if (!live.elements || !Array.isArray(live.elements)) {
    throw new Error('Invalid event live data from FPL API');
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  let errors = 0;

  const results = await mapWithConcurrency(entryIds, concurrency, async (entryId) => {
    try {
      const picks = await fplClient.getEntryEventPicks(entryId, eventId);
      await entryEventResultsRepository.upsertFromPicksAndLive(entryId, eventId, picks, live);
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      errors += 1;
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const synced = results.filter((result) => result.success).length;

  logInfo('Tournament event results sync completed', {
    eventId,
    totalEntries: entryIds.length,
    synced,
    errors,
  });

  return { eventId, totalEntries: entryIds.length, synced, errors };
}
