import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { syncEntryEventPicks } from './entries.service';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

export function findMissingTournamentPickEntryIds(
  expectedEntryIds: readonly number[],
  persistedEntryIds: ReadonlySet<number>,
): number[] {
  return expectedEntryIds.filter((entryId) => !persistedEntryIds.has(entryId));
}

export async function syncTournamentEventPicks(
  season: FplSeasonRef,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  synced: number;
  skipped: number;
  errors: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  logInfo('Starting tournament event picks sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive(season);
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for tournament event picks', { eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  );
  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for event picks', { eventId });
    return {
      eventId,
      totalEntries: 0,
      synced: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const existing = await entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds);
  const existingSet = new Set(existing);
  const toSync = entryIds.filter((entryId) => !existingSet.has(entryId));
  const skipped = existingSet.size;

  await mapWithConcurrency(toSync, concurrency, async (entryId) => {
    try {
      await syncEntryEventPicks(season, entryId, eventId);
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      logError('Failed to sync tournament entry picks', error, { eventId, entryId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  // Canonical rows, rather than request outcomes, are the checkpoint. A request
  // may fail after a concurrent worker has already completed the same unit.
  const persisted = new Set(
    await entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds),
  );
  const missingEntryIds = findMissingTournamentPickEntryIds(entryIds, persisted);
  const failedUnits = missingEntryIds.length;
  const succeededUnits = toSync.length - failedUnits;
  const synced = succeededUnits;
  const errors = failedUnits;

  logInfo('Tournament event picks sync completed', {
    eventId,
    totalEntries: entryIds.length,
    synced,
    skipped,
    errors,
  });

  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament event picks did not converge for every active entry',
      toSync.length,
      skipped,
      succeededUnits,
      failedUnits,
    );
  }

  return {
    eventId,
    totalEntries: entryIds.length,
    synced,
    skipped,
    errors,
    requiredUnits: toSync.length,
    reusedUnits: skipped,
    succeededUnits,
    failedUnits,
  };
}
