import { sql } from 'drizzle-orm';

import { playerValues, type DbPlayerValueInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlayerValue } from '../domain/player-values';

interface ValueRecord {
  elementId: number;
  value: number;
  changeDate: string;
}

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export type PlayerValuesRepository = ReturnType<typeof createPlayerValuesRepository>;

export const createPlayerValuesRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findLatestForAllPlayers: async (): Promise<ValueRecord[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db.execute(sql`
        SELECT DISTINCT ON (element_id)
          element_id as "elementId",
          value,
          change_date as "changeDate"
        FROM player_values
        ORDER BY element_id, change_date DESC, created_at DESC
      `);
        return rows as unknown as ValueRecord[];
      } catch (error) {
        logError('Failed to get latest player values', error);
        throw new DatabaseError('Failed to get latest player values', 'LATEST_VALUES_ERROR');
      }
    },

    findByChangeDate: async (changeDate: string): Promise<ValueRecord[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db.execute(sql`
        SELECT element_id as "elementId", value, change_date as "changeDate"
        FROM player_values
        WHERE change_date = ${changeDate}
      `);
        return rows as unknown as ValueRecord[];
      } catch (error) {
        logError('Failed to get player values by date', error, { changeDate });
        throw new DatabaseError('Failed to get player values by date', 'FIND_BY_DATE_ERROR');
      }
    },

    /** True when at least one rise/fall row exists for the date (ignores `start` seed rows). */
    hasChangesForDate: async (changeDate: string): Promise<boolean> => {
      try {
        const db = await getDbInstance();
        const rows = await db.execute(sql`
        SELECT 1
        FROM player_values
        WHERE change_date = ${changeDate}
          AND change_type <> 'start'
        LIMIT 1
      `);
        return rows.length > 0;
      } catch (error) {
        logError('Failed to check player values by date', error, { changeDate });
        throw new DatabaseError('Failed to check player values by date', 'CHECK_DATE_ERROR');
      }
    },

    insertBatch: async (
      playerValuesList: PlayerValue[],
    ): Promise<{ count: number; inserted: PlayerValue[] }> => {
      try {
        if (playerValuesList.length === 0) {
          return { count: 0, inserted: [] };
        }

        const rows: DbPlayerValueInsert[] = playerValuesList.map((playerValue) => ({
          eventId: playerValue.eventId,
          elementId: playerValue.elementId,
          elementType: playerValue.elementType,
          value: playerValue.value,
          changeDate: playerValue.changeDate,
          changeType:
            playerValue.changeType.toLowerCase() as (typeof playerValues.changeType)['enumValues'][number],
          lastValue: playerValue.lastValue,
        }));

        const db = await getDbInstance();
        // H6: (element_id, change_date) is unique — a concurrent or repeated
        // sync of the same day must not blow up the whole batch. returning()
        // yields only rows actually inserted so callers can cache/notify
        // without republishing conflict-skipped values (FP-10 Codex P2).
        const insertedRows = await db
          .insert(playerValues)
          .values(rows)
          .onConflictDoNothing({
            target: [playerValues.elementId, playerValues.changeDate],
          })
          .returning();
        const insertedKeys = new Set(
          insertedRows.map((row) => `${row.elementId}|${row.changeDate}`),
        );
        const inserted = playerValuesList.filter((pv) =>
          insertedKeys.has(`${pv.elementId}|${pv.changeDate}`),
        );
        logInfo('Inserted player values', {
          count: inserted.length,
          skipped: rows.length - inserted.length,
        });
        return { count: inserted.length, inserted };
      } catch (error) {
        logError('Failed to insert player values', error, { count: playerValuesList.length });
        throw new DatabaseError('Failed to insert player values', 'INSERT_ERROR');
      }
    },
  };
};

export const playerValuesRepository = createPlayerValuesRepository();
