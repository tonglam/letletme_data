import { entryInfosCache } from '../cache/entry-infos-cache';
import { fplClient } from '../clients/fpl';
import { getDb } from '../db/singleton';
import { toEntryInfo } from '../domain/entry-infos';
import { getCurrentEvent } from './events.service';
import { createEntryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { createEntryInfoRepository } from '../repositories/entry-infos';
import { createEntryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import { logInfo } from '../utils/logger';

export type EntryInfoClient = Pick<typeof fplClient, 'getEntrySummary' | 'getEntryHistory'>;

export async function syncEntryInfo(
  entryId: number,
  client: EntryInfoClient = fplClient,
  targetEventId?: number,
) {
  logInfo('Starting entry info sync', { entryId });
  const [summary, history, currentEvent] = await Promise.all([
    client.getEntrySummary(entryId),
    client.getEntryHistory(entryId),
    getCurrentEvent(),
  ]);
  const lastEventId = currentEvent ? currentEvent.id - 1 : null;
  const snapshotSyncedThroughEventId = Math.max(
    0,
    Math.min(
      38,
      targetEventId ?? history.current.reduce((latest, item) => Math.max(latest, item.event), 0),
    ),
  );

  const db = await getDb();
  const saved = await db.transaction(async (tx) => {
    const entryInfoRepository = createEntryInfoRepository(tx);
    const entryHistoryInfoRepository = createEntryHistoryInfoRepository(tx);
    const entryLeagueInfoRepository = createEntryLeagueInfoRepository(tx);
    const entryEventResultsRepository = createEntryEventResultsRepository(tx);

    // Child tables reference entry_infos. Persist the parent first, then fan
    // out independent child writes inside the same transaction so a partial
    // entry snapshot can never become visible.
    const entry = await entryInfoRepository.upsertFromSummary(
      summary,
      lastEventId,
      snapshotSyncedThroughEventId,
    );
    await Promise.all([
      entryHistoryInfoRepository.upsertFromHistory(entryId, history),
      entryLeagueInfoRepository.upsertFromLeagues(entryId, summary.leagues),
      entryEventResultsRepository.upsertCoreFromHistory(entryId, history.current),
    ]);
    return entry;
  });

  // Redis is derived state: publish only after the canonical DB transaction
  // commits. A cache failure can be retried without corrupting the snapshot.
  await entryInfosCache.setEntry(toEntryInfo(saved));
  logInfo('Entry info sync completed', { entryId });
  return saved;
}
