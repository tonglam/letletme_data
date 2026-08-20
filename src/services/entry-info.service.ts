import { fplClient } from '../clients/fpl';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { createEntryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { createEntryInfoRepository } from '../repositories/entry-infos';
import { createEntryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import { acquireEntrySeasonWriteFence } from '../repositories/entry-event-transfers';
import { eventRepository } from '../repositories/events';
import type { RawFPLEntryHistoryCurrentItem } from '../types';
import { ValidationError } from '../utils/errors';
import { logInfo } from '../utils/logger';
import { assertMutationLockHealthy } from '../utils/mutation-lock';

export type EntryInfoClient = Pick<typeof fplClient, 'getEntrySummary' | 'getEntryHistory'>;

export function validateEntryHistoryCoverage(
  startedEvent: number | null | undefined,
  targetEventId: number,
  currentHistory: readonly RawFPLEntryHistoryCurrentItem[],
): void {
  if (!Number.isInteger(targetEventId) || targetEventId < 0 || targetEventId > 38) {
    throw new ValidationError(
      'Entry snapshot target must be an event from 0 through 38.',
      'ENTRY_SNAPSHOT_TARGET_INVALID',
    );
  }

  const eventIds = currentHistory.map((item) => item.event);
  if (
    eventIds.some((eventId) => !Number.isInteger(eventId) || eventId < 1 || eventId > 38) ||
    new Set(eventIds).size !== eventIds.length
  ) {
    throw new ValidationError(
      'Entry history contains invalid or duplicate event identifiers.',
      'ENTRY_HISTORY_INVALID',
    );
  }

  const firstRequiredEvent = Math.max(1, startedEvent ?? 1);
  if (targetEventId < firstRequiredEvent) return;

  const available = new Set(eventIds);
  let missing = 0;
  for (let eventId = firstRequiredEvent; eventId <= targetEventId; eventId += 1) {
    if (!available.has(eventId)) missing += 1;
  }
  if (missing > 0) {
    throw new ValidationError(
      `Entry history is incomplete through the requested event (${missing} missing).`,
      'ENTRY_HISTORY_INCOMPLETE',
    );
  }
}

export async function syncEntryInfo(
  season: FplSeasonRef,
  entryId: number,
  client: EntryInfoClient = fplClient,
  targetEventId?: number,
) {
  const startedAt = performance.now();
  logInfo('Starting entry info sync', {
    season: season.seasonCode,
  });
  // Capture season authority before any upstream reads. A rollover during the
  // parallel FPL requests must fail the fenced commit rather than pairing old
  // payloads with the new season.
  const [summary, history, currentEvent, latestFinalizedEvent] = await Promise.all([
    client.getEntrySummary(entryId),
    client.getEntryHistory(entryId),
    eventRepository.findCurrent(season),
    targetEventId === undefined
      ? eventRepository.findLatestFinalized(season)
      : Promise.resolve(null),
  ]);
  if (summary.id !== entryId) {
    throw new ValidationError(
      'Entry summary identity did not match the request.',
      'ENTRY_ID_MISMATCH',
    );
  }
  const snapshotSyncedThroughEventId = targetEventId ?? latestFinalizedEvent?.id ?? 0;
  validateEntryHistoryCoverage(
    summary.started_event,
    snapshotSyncedThroughEventId,
    history.current,
  );
  const finalizedHistory = history.current.filter(
    (item) => item.event <= snapshotSyncedThroughEventId,
  );
  const lastEventId = currentEvent ? currentEvent.id - 1 : null;

  const db = await getDb();
  const transactionStartedAt = performance.now();
  assertMutationLockHealthy();
  const saved = await db.transaction(async (tx) => {
    assertMutationLockHealthy();
    await acquireEntrySeasonWriteFence(tx, season, [entryId]);

    const entryInfoRepository = createEntryInfoRepository(tx);
    const entryHistoryInfoRepository = createEntryHistoryInfoRepository(tx);
    const entryLeagueInfoRepository = createEntryLeagueInfoRepository(tx);
    const entryEventResultsRepository = createEntryEventResultsRepository(tx);

    // Child tables reference entry_infos. Persist the parent first, then fan
    // out independent child writes inside the same transaction so a partial
    // entry snapshot can never become visible.
    const entry = await entryInfoRepository.upsertFromSummary(
      season,
      summary,
      lastEventId,
      snapshotSyncedThroughEventId,
    );
    await Promise.all([
      entryHistoryInfoRepository.upsertFromHistory(season, entryId, history),
      entryLeagueInfoRepository.upsertFromLeagues(season, entryId, summary.leagues),
      entryEventResultsRepository.upsertCoreFromHistory(season, entryId, finalizedHistory),
    ]);
    return entry;
  });

  logInfo('Entry info sync completed', {
    season: season.seasonCode,
    leaguesSourcePresent: summary.leagues !== undefined,
    transactionDurationMs: Math.round(performance.now() - transactionStartedAt),
    totalDurationMs: Math.round(performance.now() - startedAt),
  });
  return saved;
}
