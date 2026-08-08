import { and, asc, desc, eq, gte, inArray, lt, lte, ne } from 'drizzle-orm';

import { playerValueChangesInReporting } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { ValueChangeType } from '../types/base.type';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

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

function databaseDate(changeDate: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(changeDate)) {
    return changeDate;
  }
  if (!/^\d{8}$/.test(changeDate)) {
    throw new Error(`Invalid player value date: ${changeDate}`);
  }
  return `${changeDate.slice(0, 4)}-${changeDate.slice(4, 6)}-${changeDate.slice(6)}`;
}

function apiDate(snapshotDate: string): string {
  return snapshotDate.replaceAll('-', '');
}

type PlayerValueViewRow = typeof playerValueChangesInReporting.$inferSelect;

function mapStoredPlayerValue(row: PlayerValueViewRow): StoredPlayerValue {
  if (
    row.elementId === null ||
    row.value === null ||
    row.snapshotDate === null ||
    row.eventId === null ||
    row.elementType === null ||
    row.lastValue === null
  ) {
    throw new Error('Player value view returned an incomplete row');
  }

  const changeType: ValueChangeType =
    row.changeType === 'start'
      ? 'Start'
      : row.changeType === 'rise'
        ? 'Rise'
        : row.changeType === 'fall'
          ? 'Faller'
          : (() => {
              throw new Error(`Unexpected player value change type: ${String(row.changeType)}`);
            })();

  return {
    elementId: row.elementId,
    value: row.value,
    changeDate: apiDate(row.snapshotDate),
    eventId: row.eventId,
    elementType: row.elementType,
    changeType,
    lastValue: row.lastValue,
  };
}

export type PlayerValuesRepository = ReturnType<typeof createPlayerValuesRepository>;

export const createPlayerValuesRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findLatestForAllPlayers: async (
      season: FplSeasonRef,
      fromChangeDate: string,
      throughChangeDate: string,
    ): Promise<ValueRecord[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(playerValueChangesInReporting)
          .where(
            and(
              eq(playerValueChangesInReporting.seasonId, season.seasonId),
              gte(playerValueChangesInReporting.snapshotDate, databaseDate(fromChangeDate)),
              lte(playerValueChangesInReporting.snapshotDate, databaseDate(throughChangeDate)),
            ),
          )
          .orderBy(
            asc(playerValueChangesInReporting.elementId),
            desc(playerValueChangesInReporting.snapshotDate),
          );

        const latest = new Map<number, ValueRecord>();
        for (const row of rows) {
          const mapped = mapStoredPlayerValue(row);
          if (!latest.has(mapped.elementId)) {
            latest.set(mapped.elementId, mapped);
          }
        }
        return [...latest.values()];
      } catch (error) {
        logError('Failed to get latest player values', error, {
          season: season.seasonCode,
          fromChangeDate,
          throughChangeDate,
        });
        throw new DatabaseError(
          'Failed to get latest player values',
          'LATEST_VALUES_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByChangeDate: async (
      season: FplSeasonRef,
      changeDate: string,
    ): Promise<StoredPlayerValue[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(playerValueChangesInReporting)
          .where(
            and(
              eq(playerValueChangesInReporting.seasonId, season.seasonId),
              eq(playerValueChangesInReporting.snapshotDate, databaseDate(changeDate)),
            ),
          );
        return rows.map(mapStoredPlayerValue);
      } catch (error) {
        logError('Failed to get player values by date', error, {
          season: season.seasonCode,
          changeDate,
        });
        throw new DatabaseError(
          'Failed to get player values by date',
          'FIND_BY_DATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findLatestForPlayerIds: async (
      season: FplSeasonRef,
      elementIds: number[],
      fromChangeDate: string,
      beforeChangeDate: string,
      _asOf?: Date,
    ): Promise<StoredPlayerValue[]> => {
      if (elementIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(playerValueChangesInReporting)
          .where(
            and(
              eq(playerValueChangesInReporting.seasonId, season.seasonId),
              inArray(playerValueChangesInReporting.elementId, [...new Set(elementIds)]),
              gte(playerValueChangesInReporting.snapshotDate, databaseDate(fromChangeDate)),
              lt(playerValueChangesInReporting.snapshotDate, databaseDate(beforeChangeDate)),
            ),
          )
          .orderBy(
            asc(playerValueChangesInReporting.elementId),
            desc(playerValueChangesInReporting.snapshotDate),
          );

        const latest = new Map<number, StoredPlayerValue>();
        for (const row of rows) {
          const mapped = mapStoredPlayerValue(row);
          if (!latest.has(mapped.elementId)) {
            latest.set(mapped.elementId, mapped);
          }
        }
        return [...latest.values()];
      } catch (error) {
        logError('Failed to get latest player values by player IDs', error, {
          season: season.seasonCode,
          count: elementIds.length,
          fromChangeDate,
          beforeChangeDate,
        });
        throw new DatabaseError(
          'Failed to get latest player values by player IDs',
          'LATEST_VALUES_BY_IDS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    hasChangesForDate: async (season: FplSeasonRef, changeDate: string): Promise<boolean> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ elementId: playerValueChangesInReporting.elementId })
          .from(playerValueChangesInReporting)
          .where(
            and(
              eq(playerValueChangesInReporting.seasonId, season.seasonId),
              eq(playerValueChangesInReporting.snapshotDate, databaseDate(changeDate)),
              ne(playerValueChangesInReporting.changeType, 'start'),
            ),
          )
          .limit(1);
        return rows.length > 0;
      } catch (error) {
        logError('Failed to check player values by date', error, {
          season: season.seasonCode,
          changeDate,
        });
        throw new DatabaseError(
          'Failed to check player values by date',
          'CHECK_DATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const playerValuesRepository = createPlayerValuesRepository();
