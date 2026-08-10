import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  entryEventCupResultsRepository,
  type EntryEventCupResultInput,
} from '../repositories/entry-event-cup-results';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryCupMatch } from '../types';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logDebug, logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

type GetEntryCup = typeof fplClient.getEntryCup;

type EntryCupOutcome = {
  entryId: number;
  record: EntryEventCupResultInput | null;
  error?: Error;
};

function resolveMatch(entryId: number, matches: RawFPLEntryCupMatch[], eventId: number) {
  const match = matches.find((item) => item.event === eventId);
  if (!match) {
    return null;
  }

  const isEntry1 = entryId === match.entry_1_entry;
  if (!isEntry1 && entryId !== match.entry_2_entry) {
    return null;
  }

  const entryName = isEntry1 ? match.entry_1_name : match.entry_2_name;
  const playerName = isEntry1 ? match.entry_1_player_name : match.entry_2_player_name;
  const eventPoints = isEntry1 ? match.entry_1_points : match.entry_2_points;
  const againstEntryId = isEntry1 ? match.entry_2_entry : match.entry_1_entry;
  const againstEntryName = isEntry1 ? match.entry_2_name : match.entry_1_name;
  const againstPlayerName = isEntry1 ? match.entry_2_player_name : match.entry_1_player_name;
  const againstEventPoints = isEntry1 ? match.entry_2_points : match.entry_1_points;
  const winner = match.winner ?? 0;
  const entryScore = eventPoints ?? 0;
  const againstScore = againstEventPoints ?? 0;
  const result = winner === 0 ? entryScore >= againstScore : winner === entryId;

  return {
    entryName: entryName ?? null,
    playerName: playerName ?? null,
    opponentEntryId: againstEntryId ?? null,
    opponentName: againstEntryName ?? null,
    entryPoints: entryScore,
    opponentPoints: againstScore,
    eventPoints: eventPoints ?? null,
    againstEntryId: againstEntryId ?? null,
    againstEntryName: againstEntryName ?? null,
    againstPlayerName: againstPlayerName ?? null,
    againstEventPoints: againstEventPoints ?? null,
    result: result ? 'win' : 'loss',
  } satisfies Omit<EntryEventCupResultInput, 'eventId' | 'entryId'>;
}

async function buildEntryCupResult(
  entryId: number,
  eventId: number,
  getEntryCup: GetEntryCup,
): Promise<EntryEventCupResultInput | null> {
  const cup = await getEntryCup(entryId);
  if (!cup) {
    return null;
  }
  const match = resolveMatch(entryId, cup.cup_matches ?? [], eventId);
  if (!match) {
    logDebug('Entry cup match missing for event', { entryId, eventId });
    return null;
  }

  return {
    entryId,
    eventId,
    ...match,
  };
}

export async function collectEntryCupResults(
  entryIds: number[],
  eventId: number,
  options?: { concurrency?: number; getEntryCup?: GetEntryCup },
) {
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const getEntryCup = options?.getEntryCup ?? fplClient.getEntryCup.bind(fplClient);
  let skipped = 0;
  let errors = 0;

  const outcomes = await mapWithConcurrency(entryIds, concurrency, async (entryId) => {
    try {
      const record = await buildEntryCupResult(entryId, eventId, getEntryCup);
      if (!record) {
        skipped += 1;
        return { entryId, record: null } satisfies EntryCupOutcome;
      }
      return { entryId, record } satisfies EntryCupOutcome;
    } catch (error) {
      errors += 1;
      logError('Failed to fetch entry cup result', error, { entryId, eventId });
      return { entryId, record: null, error: error as Error } satisfies EntryCupOutcome;
    }
  });

  return {
    records: outcomes
      .map((outcome) => outcome.record)
      .filter((record): record is EntryEventCupResultInput => Boolean(record)),
    skipped,
    errors,
  };
}

export async function syncTournamentEventCupResults(
  season: FplSeasonRef,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  upserted: number;
  skipped: number;
  errors: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  if (eventId < 17 || eventId > 38) {
    logInfo('Skipping tournament event cup results sync - invalid event', { eventId });
    return {
      eventId,
      totalEntries: 0,
      upserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  logInfo('Starting tournament event cup results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive(season);
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for cup results', { eventId });
    return {
      eventId,
      totalEntries: 0,
      upserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for cup results', { eventId });
    return {
      eventId,
      totalEntries: 0,
      upserted: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const { records, skipped, errors } = await collectEntryCupResults(entryIds, eventId, options);

  const upserted = await entryEventCupResultsRepository.replaceBatch(season, records);
  if (upserted !== records.length) {
    throw new Error(
      `Tournament event cup results lost season ownership for ${records.length - upserted} entries`,
    );
  }

  logInfo('Tournament event cup results sync completed', {
    eventId,
    totalEntries: entryIds.length,
    upserted,
    skipped,
    errors,
  });

  const writeFailures = Math.max(0, records.length - upserted);
  const failedUnits = errors + writeFailures;
  const succeededUnits = entryIds.length - failedUnits;
  if (failedUnits > 0) {
    throw new IncompleteDataSyncError(
      'Tournament cup results did not converge for every requested entry',
      entryIds.length,
      0,
      succeededUnits,
      failedUnits,
    );
  }

  return {
    eventId,
    totalEntries: entryIds.length,
    upserted,
    skipped,
    errors,
    requiredUnits: entryIds.length,
    reusedUnits: 0,
    succeededUnits,
    failedUnits,
  };
}
