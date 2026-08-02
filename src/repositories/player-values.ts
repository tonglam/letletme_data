import { asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { playerValues, type DbPlayerValueInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlayerValue } from '../domain/player-values';
import type { ValueChangeType } from '../types/base.type';

interface ValueRecord {
  elementId: number;
  value: number;
  changeDate: string;
}

export interface StoredPlayerValue extends ValueRecord {
  eventId: number;
  elementType: number;
  changeType: ValueChangeType;
  lastValue: number;
}

function mapStoredPlayerValue(row: {
  elementId: number;
  value: number;
  changeDate: string;
  eventId: number;
  elementType: number;
  changeType: 'start' | 'rise' | 'fall';
  lastValue: number;
}): StoredPlayerValue {
  const changeType: ValueChangeType =
    row.changeType === 'start' ? 'Start' : row.changeType === 'rise' ? 'Rise' : 'Faller';
  return { ...row, changeType };
}

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export type PlayerValuesRepository = ReturnType<typeof createPlayerValuesRepository>;

export const createPlayerValuesRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findLatestForAllPlayers: async (
      fromChangeDate: string,
      throughChangeDate: string,
    ): Promise<ValueRecord[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db.execute(sql`
        SELECT DISTINCT ON (element_id)
          element_id as "elementId",
          value,
          change_date as "changeDate"
        FROM player_values
        WHERE change_date >= ${fromChangeDate}
          AND change_date <= ${throughChangeDate}
        ORDER BY element_id, change_date DESC, created_at DESC
      `);
        return rows as unknown as ValueRecord[];
      } catch (error) {
        logError('Failed to get latest player values', error, {
          fromChangeDate,
          throughChangeDate,
        });
        throw new DatabaseError('Failed to get latest player values', 'LATEST_VALUES_ERROR');
      }
    },

    findDistinctPlayerIds: async (
      fromChangeDate: string,
      throughChangeDate: string,
    ): Promise<number[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .selectDistinct({ elementId: playerValues.elementId })
          .from(playerValues).where(sql`
            ${playerValues.changeDate} >= ${fromChangeDate}
            AND ${playerValues.changeDate} <= ${throughChangeDate}
          `);
        return rows.map((row) => row.elementId);
      } catch (error) {
        logError('Failed to get current-season player value IDs', error, {
          fromChangeDate,
          throughChangeDate,
        });
        throw new DatabaseError(
          'Failed to get current-season player value IDs',
          'PLAYER_VALUE_IDS_ERROR',
        );
      }
    },

    findByChangeDate: async (changeDate: string): Promise<StoredPlayerValue[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            elementId: playerValues.elementId,
            value: playerValues.value,
            changeDate: playerValues.changeDate,
            eventId: playerValues.eventId,
            elementType: playerValues.elementType,
            changeType: playerValues.changeType,
            lastValue: playerValues.lastValue,
          })
          .from(playerValues)
          .where(eq(playerValues.changeDate, changeDate));
        return rows.map(mapStoredPlayerValue);
      } catch (error) {
        logError('Failed to get player values by date', error, { changeDate });
        throw new DatabaseError('Failed to get player values by date', 'FIND_BY_DATE_ERROR');
      }
    },

    findLatestForPlayerIds: async (elementIds: number[]): Promise<StoredPlayerValue[]> => {
      if (elementIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(elementIds));
        const rows = await db
          .select({
            elementId: playerValues.elementId,
            value: playerValues.value,
            changeDate: playerValues.changeDate,
            eventId: playerValues.eventId,
            elementType: playerValues.elementType,
            changeType: playerValues.changeType,
            lastValue: playerValues.lastValue,
          })
          .from(playerValues)
          .where(inArray(playerValues.elementId, uniqueIds))
          .orderBy(
            asc(playerValues.elementId),
            desc(playerValues.changeDate),
            desc(playerValues.createdAt),
          );

        const seen = new Set<number>();
        const latest: StoredPlayerValue[] = [];
        for (const row of rows) {
          if (!seen.has(row.elementId)) {
            seen.add(row.elementId);
            latest.push(mapStoredPlayerValue(row));
          }
        }
        return latest;
      } catch (error) {
        logError('Failed to get latest player values by player IDs', error, {
          count: elementIds.length,
        });
        throw new DatabaseError(
          'Failed to get latest player values by player IDs',
          'LATEST_VALUES_BY_IDS_ERROR',
        );
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
            playerValue.changeType === 'Faller'
              ? 'fall'
              : (playerValue.changeType.toLowerCase() as 'start' | 'rise'),
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
