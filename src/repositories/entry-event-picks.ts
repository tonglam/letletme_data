import { and, eq, inArray, sql } from 'drizzle-orm';
import { entryEventPicks, entryInfos } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { toDbChip } from '../domain/chips';
import { isCompleteEntryPicks, isEntryPicksPayloadForEvent } from '../domain/entry-picks';
import type { RawFPLEntryEventPicksResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export const createEntryEventPicksRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findEntryIdsByEvent: async (
      eventId: number,
      entryIds: number[] | undefined,
      checkpointSeason: string,
    ): Promise<number[]> => {
      try {
        if (!/^\d{4}$/.test(checkpointSeason)) {
          throw new Error('A valid four-digit checkpoint season is required');
        }
        const db = await getDbInstance();

        if (!entryIds || entryIds.length === 0) {
          const rows = await db
            .select({ entryId: entryEventPicks.entryId, picks: entryEventPicks.picks })
            .from(entryEventPicks)
            .innerJoin(entryInfos, eq(entryInfos.id, entryEventPicks.entryId))
            .where(
              and(
                eq(entryEventPicks.eventId, eventId),
                eq(entryInfos.entrySnapshotSyncedSeason, checkpointSeason),
              ),
            );
          return rows.filter((row) => isCompleteEntryPicks(row.picks)).map((row) => row.entryId);
        }

        const uniqueEntryIds = Array.from(new Set(entryIds));
        const chunks = chunkArray(uniqueEntryIds, 1000);
        const results: number[] = [];

        for (const chunk of chunks) {
          const rows = await db
            .select({ entryId: entryEventPicks.entryId, picks: entryEventPicks.picks })
            .from(entryEventPicks)
            .innerJoin(entryInfos, eq(entryInfos.id, entryEventPicks.entryId))
            .where(
              and(
                eq(entryEventPicks.eventId, eventId),
                inArray(entryEventPicks.entryId, chunk),
                eq(entryInfos.entrySnapshotSyncedSeason, checkpointSeason),
              ),
            );
          results.push(
            ...rows.filter((row) => isCompleteEntryPicks(row.picks)).map((row) => row.entryId),
          );
        }

        return results;
      } catch (error) {
        logError('Failed to retrieve entry ids by event', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve entry ids by event',
          'ENTRY_EVENT_PICKS_FIND_ERROR',
          error as Error,
        );
      }
    },

    upsertFromPicks: async (
      entryId: number,
      eventId: number,
      picks: RawFPLEntryEventPicksResponse,
      syncedAt: Date | string = new Date(),
    ): Promise<void> => {
      try {
        if (!isEntryPicksPayloadForEvent(picks, eventId)) {
          throw new Error(
            `Refusing entry picks for an unexpected event for entry ${entryId}, event ${eventId}`,
          );
        }
        if (!isCompleteEntryPicks(picks.picks)) {
          throw new Error(`Refusing incomplete entry picks for entry ${entryId}, event ${eventId}`);
        }

        const db = await getDbInstance();
        const exactSyncedAt = syncedAt instanceof Date ? syncedAt.toISOString() : syncedAt;
        const syncedAtSql = sql`${exactSyncedAt}::timestamptz`;
        const insert = {
          entryId,
          eventId,
          chip: toDbChip(picks.active_chip),
          picks: picks.picks as unknown,
          transfers: picks.entry_history.event_transfers,
          transfersCost: picks.entry_history.event_transfers_cost,
          updatedAt: syncedAtSql,
        };

        await db
          .insert(entryEventPicks)
          .values(insert)
          .onConflictDoUpdate({
            target: [entryEventPicks.entryId, entryEventPicks.eventId],
            // updated_at is the evidence timestamp for this picks-only row.
            // A slower result attempt must not replace a newer squad.
            where: sql`
              ${entryEventPicks.updatedAt} IS NULL
              OR ${entryEventPicks.updatedAt} < ${syncedAtSql}
            `,
            set: {
              chip: insert.chip,
              picks: insert.picks,
              transfers: insert.transfers,
              transfersCost: insert.transfersCost,
              updatedAt: syncedAtSql,
            },
          });
        logInfo('Upserted entry event picks', { entryId, eventId, chip: insert.chip });
      } catch (error) {
        logError('Failed to upsert entry event picks', error, { entryId, eventId });
        throw new DatabaseError(
          'Failed to upsert entry event picks',
          'ENTRY_EVENT_PICKS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const entryEventPicksRepository = createEntryEventPicksRepository();
