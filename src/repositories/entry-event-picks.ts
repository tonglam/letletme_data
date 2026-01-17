import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { entryEventPicks, type DbEntryEventPickInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryEventPicksResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

function mapChip(
  chip: RawFPLEntryEventPicksResponse['active_chip'],
): 'n/a' | 'wildcard' | 'freehit' | 'bboost' | '3xc' | 'manager' {
  return chip ?? 'n/a';
}

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

export const createEntryEventPicksRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findEntryIdsByEvent: async (eventId: number, entryIds?: number[]): Promise<number[]> => {
      try {
        const db = await getDbInstance();

        if (!entryIds || entryIds.length === 0) {
          const rows = await db
            .select({ entryId: entryEventPicks.entryId })
            .from(entryEventPicks)
            .where(eq(entryEventPicks.eventId, eventId));
          return rows.map((row) => row.entryId);
        }

        const uniqueEntryIds = Array.from(new Set(entryIds));
        const chunks = chunkArray(uniqueEntryIds, 1000);
        const results: number[] = [];

        for (const chunk of chunks) {
          const rows = await db
            .select({ entryId: entryEventPicks.entryId })
            .from(entryEventPicks)
            .where(
              and(eq(entryEventPicks.eventId, eventId), inArray(entryEventPicks.entryId, chunk)),
            );
          results.push(...rows.map((row) => row.entryId));
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
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const insert: DbEntryEventPickInsert = {
          entryId,
          eventId,
          chip: mapChip(picks.active_chip),
          picks: picks.picks as unknown,
          transfers: picks.entry_history.event_transfers,
          transfersCost: picks.entry_history.event_transfers_cost,
        };

        await db
          .insert(entryEventPicks)
          .values(insert)
          .onConflictDoUpdate({
            target: [entryEventPicks.entryId, entryEventPicks.eventId],
            set: {
              chip: insert.chip,
              picks: insert.picks,
              transfers: insert.transfers,
              transfersCost: insert.transfersCost,
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
