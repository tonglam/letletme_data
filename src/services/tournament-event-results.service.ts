import { fplClient } from '../clients/fpl';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers, withTimeout } from '../utils/async';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;
const EVENT_LIVE_FETCH_TIMEOUT_MS = Number(process.env.TOURNAMENT_EVENT_LIVE_TIMEOUT_MS ?? 45_000);
const ENTRY_FETCH_TIMEOUT_MS = Number(process.env.TOURNAMENT_ENTRY_FETCH_TIMEOUT_MS ?? 45_000);
const ENTRY_PERSIST_TIMEOUT_MS = Number(process.env.TOURNAMENT_ENTRY_PERSIST_TIMEOUT_MS ?? 60_000);

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

export async function syncTournamentEventResultsForEntryIds(
  entryIds: number[],
  eventId: number,
  options?: { concurrency?: number },
): Promise<{ eventId: number; totalEntries: number; synced: number; errors: number }> {
  const uniqueEntryIds = uniqueNumbers(entryIds);
  if (uniqueEntryIds.length === 0) {
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const live = await withTimeout(
    fplClient.getEventLive(eventId),
    EVENT_LIVE_FETCH_TIMEOUT_MS,
    `Timed out fetching event live data for event ${eventId} after ${EVENT_LIVE_FETCH_TIMEOUT_MS}ms`,
  );
  if (!live.elements || !Array.isArray(live.elements)) {
    throw new Error('Invalid event live data from FPL API');
  }
  const pointsByElement = new Map<number, number>();
  for (const element of live.elements) {
    pointsByElement.set(element.id, element.stats.total_points);
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  let errors = 0;

  const results = await mapWithConcurrency(uniqueEntryIds, concurrency, async (entryId) => {
    try {
      const [picks, transfers] = await withTimeout(
        Promise.all([
          fplClient.getEntryEventPicks(entryId, eventId),
          fplClient.getEntryTransfers(entryId),
        ]),
        ENTRY_FETCH_TIMEOUT_MS,
        `Timed out fetching entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_FETCH_TIMEOUT_MS}ms`,
      );
      await withTimeout(
        Promise.all([
          entryEventResultsRepository.upsertFromPicksAndLive(entryId, eventId, picks, live),
          entryEventPicksRepository.upsertFromPicks(entryId, eventId, picks),
          entryEventTransfersRepository.replaceForEvent(
            entryId,
            eventId,
            transfers,
            pointsByElement,
          ),
        ]),
        ENTRY_PERSIST_TIMEOUT_MS,
        `Timed out persisting entry payloads for entry ${entryId}, event ${eventId} after ${ENTRY_PERSIST_TIMEOUT_MS}ms`,
      );
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      errors += 1;
      logError('Failed to sync tournament entry results', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const synced = results.filter((result) => result.success).length;
  const totalEntries = uniqueEntryIds.length;
  if (errors > 0) {
    throw new Error(
      `Tournament event results sync failed for ${errors} of ${totalEntries} entries`,
    );
  }
  return {
    eventId,
    totalEntries,
    synced,
    errors,
  };
}

export async function syncTournamentEventResultsForTournament(
  tournamentId: number,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{ eventId: number; totalEntries: number; synced: number; errors: number }> {
  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournamentId);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event results', { tournamentId, eventId });
    return { eventId, totalEntries: 0, synced: 0, errors: 0 };
  }

  const result = await syncTournamentEventResultsForEntryIds(entryIds, eventId, options);
  logInfo('Tournament event results sync completed for tournament', {
    tournamentId,
    eventId,
    totalEntries: result.totalEntries,
    synced: result.synced,
    errors: result.errors,
  });
  return result;
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
  const { totalEntries, synced, errors } = await syncTournamentEventResultsForEntryIds(
    entryIds,
    eventId,
    options,
  );

  logInfo('Tournament event results sync completed', {
    eventId,
    totalEntries,
    synced,
    errors,
  });

  return { eventId, totalEntries, synced, errors };
}
