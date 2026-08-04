import { eq, sql } from 'drizzle-orm';

import { entryInfosCache } from '../cache/entry-infos-cache';
import {
  acquireActiveSeasonReadFence,
  getActiveCacheSeason,
  getActiveCacheSeasonUncached,
} from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import { getDb } from '../db/singleton';
import { toEntryInfo } from '../domain/entry-infos';
import { getCurrentEvent } from './events.service';
import { createEntryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { createEntryInfoRepository } from '../repositories/entry-infos';
import { createEntryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { createEntryEventResultsRepository } from '../repositories/entry-event-results';
import {
  entryEventCupResults,
  entryEventPicks,
  entryEventResults,
  entryEventTransfers,
  entryInfos,
  leagueEventResults,
} from '../db/schemas/index.schema';
import { ENTRY_SEASON_SYNC_LOCK_NAMESPACE } from '../repositories/entry-event-transfers';
import { eventRepository } from '../repositories/events';
import { logInfo } from '../utils/logger';

export type EntryInfoClient = Pick<typeof fplClient, 'getEntrySummary' | 'getEntryHistory'>;

export async function syncEntryInfo(
  entryId: number,
  client: EntryInfoClient = fplClient,
  targetEventId?: number,
  snapshotSeason?: string,
) {
  logInfo('Starting entry info sync', { entryId });
  const [summary, history, currentEvent, latestFinalizedEvent, activeSeason] = await Promise.all([
    client.getEntrySummary(entryId),
    client.getEntryHistory(entryId),
    getCurrentEvent(),
    eventRepository.findLatestFinalized(),
    snapshotSeason ? Promise.resolve(snapshotSeason) : getActiveCacheSeason(),
  ]);
  const lastEventId = currentEvent ? currentEvent.id - 1 : null;
  const snapshotSyncedThroughEventId = Math.max(
    0,
    Math.min(38, targetEventId ?? latestFinalizedEvent?.id ?? 0),
  );

  const db = await getDb();
  const saved = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ENTRY_SEASON_SYNC_LOCK_NAMESPACE}, ${entryId})`,
    );
    // Pin annual season authority across the canonical commit. FPL reads stay
    // outside the transaction; one uncached Redis read under the shared fence
    // rejects a setup that crossed rollover instead of tagging old rows as new.
    await acquireActiveSeasonReadFence(tx);
    const canonicalSeason = await getActiveCacheSeasonUncached();
    if (canonicalSeason !== activeSeason) {
      throw new Error(
        `Active season changed from ${activeSeason} to ${canonicalSeason} during entry snapshot sync`,
      );
    }
    const currentRows = await tx
      .select({
        snapshotSeason: entryInfos.entrySnapshotSyncedSeason,
        transferSeason: entryInfos.entryTransfersSyncedSeason,
      })
      .from(entryInfos)
      .where(eq(entryInfos.id, entryId));
    const current = currentRows[0];
    const newestPersistedSeason = [current?.snapshotSeason, current?.transferSeason]
      .filter((season): season is string => season !== null && season !== undefined)
      .sort()
      .at(-1);
    if (newestPersistedSeason && newestPersistedSeason > activeSeason) {
      throw new Error(
        `Refusing stale ${activeSeason} entry snapshot after ${newestPersistedSeason}`,
      );
    }

    // A different or legacy NULL checkpoint cannot prove ownership of
    // event-numbered rows. Clear them in the same per-entry transaction before
    // adopting the active season and seeding current core history.
    if (current?.snapshotSeason !== activeSeason) {
      await Promise.all([
        tx.delete(entryEventCupResults).where(eq(entryEventCupResults.entryId, entryId)),
        tx.delete(entryEventPicks).where(eq(entryEventPicks.entryId, entryId)),
        tx.delete(entryEventResults).where(eq(entryEventResults.entryId, entryId)),
        tx.delete(leagueEventResults).where(eq(leagueEventResults.entryId, entryId)),
      ]);
      // A current-season transfer sync can win this per-entry lock before the
      // first current-season snapshot. Its checkpoint proves those rows are
      // already current, so the later snapshot rollover must preserve them.
      // NULL or another season cannot prove ownership and is cleared.
      if (current?.transferSeason !== activeSeason) {
        await tx.delete(entryEventTransfers).where(eq(entryEventTransfers.entryId, entryId));
      }
    }

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
      activeSeason,
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
