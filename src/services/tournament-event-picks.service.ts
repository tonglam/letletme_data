import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { syncEntryEventPicks } from './entries.service';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

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
  let synced = 0;
  let errors = 0;

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );
  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event picks', { eventId });
    return { eventId, totalEntries: 0, synced: 0, skipped: 0, errors: 0 };
  }

  const existing = await entryEventPicksRepository.findEntryIdsByEvent(eventId, entryIds);
  const existingSet = new Set(existing);
  const toSync = entryIds.filter((entryId) => !existingSet.has(entryId));
  const skipped = existing.length;

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

  logInfo('Tournament event picks sync completed', {
    eventId,
    totalEntries: entryIds.length,
    synced,
    skipped,
    errors,
  });

  return { eventId, totalEntries: entryIds.length, synced, skipped, errors };
}
