import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { syncEntryEventPicks } from './entries.service';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

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

export async function syncTournamentEventPicks(
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  synced: number;
  skipped: number;
  errors: number;
}> {
  logInfo('Starting tournament event picks sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event picks', { eventId });
    return { eventId, totalEntries: 0, synced: 0, skipped: 0, errors: 0 };
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  let totalEntries = 0;
  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const tournament of tournaments) {
    const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
    if (entryIds.length === 0) {
      logInfo('No tournament entries found for event picks', {
        eventId,
        tournamentId: tournament.id,
      });
      continue;
    }

    totalEntries += entryIds.length;

    const existing = await entryEventPicksRepository.findEntryIdsByEvent(eventId, entryIds);
    const existingSet = new Set(existing);
    const toSync = entryIds.filter((entryId) => !existingSet.has(entryId));
    skipped += existing.length;

    if (toSync.length === 0) {
      logInfo('Tournament entries already synced for event picks', {
        eventId,
        tournamentId: tournament.id,
      });
      continue;
    }

    const results = await mapWithConcurrency(toSync, concurrency, async (entryId) => {
      try {
        await syncEntryEventPicks(entryId, eventId);
        return { entryId, success: true } satisfies EntrySyncOutcome;
      } catch (error) {
        errors += 1;
        logError('Failed to sync tournament entry picks', error, { eventId, entryId });
        return { entryId, success: false } satisfies EntrySyncOutcome;
      }
    });

    synced += results.filter((result) => result.success).length;
  }

  logInfo('Tournament event picks sync completed', {
    eventId,
    totalEntries,
    synced,
    skipped,
    errors,
  });

  return { eventId, totalEntries, synced, skipped, errors };
}
