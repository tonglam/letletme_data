import type { DbEntryEventCupResultInsert } from '../db/schemas/index.schema';
import { fplClient } from '../clients/fpl';
import { entryEventCupResultsRepository } from '../repositories/entry-event-cup-results';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryCupMatch } from '../types';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { logDebug, logError, logInfo } from '../utils/logger';

const DEFAULT_CONCURRENCY = 5;

type GetEntryCup = typeof fplClient.getEntryCup;

type EntryCupOutcome = {
  entryId: number;
  record: DbEntryEventCupResultInsert | null;
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
    eventPoints: eventPoints ?? null,
    againstEntryId: againstEntryId ?? null,
    againstEntryName: againstEntryName ?? null,
    againstPlayerName: againstPlayerName ?? null,
    againstEventPoints: againstEventPoints ?? null,
    result: result ? 'win' : 'loss',
  } satisfies Omit<DbEntryEventCupResultInsert, 'eventId' | 'entryId'>;
}

async function buildEntryCupResult(
  entryId: number,
  eventId: number,
  getEntryCup: GetEntryCup,
): Promise<DbEntryEventCupResultInsert | null> {
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
      .filter((record): record is DbEntryEventCupResultInsert => Boolean(record)),
    skipped,
    errors,
  };
}

export async function syncTournamentEventCupResults(
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  eventId: number;
  totalEntries: number;
  upserted: number;
  skipped: number;
  errors: number;
}> {
  if (eventId < 17 || eventId > 38) {
    logInfo('Skipping tournament event cup results sync - invalid event', { eventId });
    return { eventId, totalEntries: 0, upserted: 0, skipped: 0, errors: 0 };
  }

  logInfo('Starting tournament event cup results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findActive();
  if (tournaments.length === 0) {
    logInfo('No active tournaments found for cup results', { eventId });
    return { eventId, totalEntries: 0, upserted: 0, skipped: 0, errors: 0 };
  }

  const entryLists = await Promise.all(
    tournaments.map((tournament) =>
      tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id),
    ),
  );

  const entryIds = uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for cup results', { eventId });
    return { eventId, totalEntries: 0, upserted: 0, skipped: 0, errors: 0 };
  }

  const { records, skipped, errors } = await collectEntryCupResults(entryIds, eventId, options);

  const upserted = await entryEventCupResultsRepository.upsertBatch(records);

  logInfo('Tournament event cup results sync completed', {
    eventId,
    totalEntries: entryIds.length,
    upserted,
    skipped,
    errors,
  });

  if (errors > 0) {
    throw new Error(
      `Tournament event cup results sync failed for ${errors} of ${entryIds.length} entries`,
    );
  }

  return { eventId, totalEntries: entryIds.length, upserted, skipped, errors };
}
