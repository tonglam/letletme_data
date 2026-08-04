import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventCupResults,
  entryInfos,
  type DbEntryEventCupResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { acquireEntrySeasonWriteFence } from './entry-event-transfers';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createEntryEventCupResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertBatch: async (
      results: DbEntryEventCupResultInsert[],
      checkpointSeason: string,
    ): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        if (!/^\d{4}$/.test(checkpointSeason)) {
          throw new Error('A valid four-digit checkpoint season is required');
        }
        const db = await getDbInstance();
        const persisted = await db.transaction(async (tx) => {
          const entryIds = results.map((result) => result.entryId);
          await acquireEntrySeasonWriteFence(tx, entryIds, checkpointSeason);
          const eligibleEntries = await tx
            .select({ id: entryInfos.id })
            .from(entryInfos)
            .where(
              and(
                inArray(entryInfos.id, entryIds),
                eq(entryInfos.entrySnapshotSyncedSeason, checkpointSeason),
              ),
            )
            .for('share');
          const eligibleIds = new Set(eligibleEntries.map((entry) => entry.id));
          const eligibleResults = results.filter((result) => eligibleIds.has(result.entryId));
          if (eligibleResults.length === 0) {
            return 0;
          }

          await tx
            .insert(entryEventCupResults)
            .values(eligibleResults)
            .onConflictDoUpdate({
              target: [entryEventCupResults.entryId, entryEventCupResults.eventId],
              set: {
                entryName: sql`excluded.entry_name`,
                playerName: sql`excluded.player_name`,
                eventPoints: sql`excluded.event_points`,
                againstEntryId: sql`excluded.against_entry_id`,
                againstEntryName: sql`excluded.against_entry_name`,
                againstPlayerName: sql`excluded.against_player_name`,
                againstEventPoints: sql`excluded.against_event_points`,
                result: sql`excluded.result`,
                updatedAt: new Date(),
              },
            });
          return eligibleResults.length;
        });

        logInfo('Upserted entry event cup results', {
          requested: results.length,
          persisted,
          checkpointSeason,
        });
        return persisted;
      } catch (error) {
        logError('Failed to upsert entry event cup results', error, { count: results.length });
        throw new DatabaseError(
          'Failed to upsert entry event cup results',
          'ENTRY_EVENT_CUP_RESULTS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const entryEventCupResultsRepository = createEntryEventCupResultsRepository();
