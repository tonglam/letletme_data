import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';

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

interface PlayerValueAsOfRow extends Record<string, unknown> {
  elementId: number;
  value: number;
  snapshotDate: string;
  eventId: number | null;
  elementType: number;
  lastValue: number;
  changeType: ValueChangeType;
}

function mapPlayerValueAsOf(row: PlayerValueAsOfRow): StoredPlayerValue {
  if (row.eventId === null) {
    throw new Error('Player market snapshot returned without an event');
  }
  return {
    elementId: row.elementId,
    value: row.value,
    changeDate: apiDate(row.snapshotDate),
    eventId: row.eventId,
    elementType: row.elementType,
    changeType: row.changeType,
    lastValue: row.lastValue,
  };
}

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
      asOf?: Date,
    ): Promise<StoredPlayerValue[]> => {
      if (elementIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueElementIds = [...new Set(elementIds)];
        const elementIdList = sql.join(
          uniqueElementIds.map((elementId) => sql`${elementId}`),
          sql.raw(', '),
        );
        const capturedAtCutoff = asOf
          ? sql`AND snapshot.captured_at <= ${asOf.toISOString()}::timestamptz`
          : sql``;
        const rows = await db.execute<PlayerValueAsOfRow>(sql`
          WITH ordered_snapshots AS (
            SELECT
              snapshot.season_id,
              snapshot.snapshot_date,
              snapshot.element_id,
              snapshot.element_type,
              snapshot.price,
              snapshot.source_event_id,
              lag(snapshot.price) OVER (
                PARTITION BY snapshot.season_id, snapshot.element_id
                ORDER BY snapshot.snapshot_date
              ) AS previous_price,
              row_number() OVER (
                PARTITION BY snapshot.season_id, snapshot.element_id
                ORDER BY snapshot.snapshot_date
              ) AS snapshot_number
            FROM fpl.player_market_snapshots snapshot
            WHERE snapshot.season_id = ${season.seasonId}
              AND snapshot.element_id IN (${elementIdList})
              AND snapshot.snapshot_date >= ${databaseDate(fromChangeDate)}::date
              AND snapshot.snapshot_date < ${databaseDate(beforeChangeDate)}::date
              ${capturedAtCutoff}
          ), changed_snapshots AS (
            SELECT ordered.*
            FROM ordered_snapshots ordered
            WHERE ordered.snapshot_number = 1
               OR ordered.price IS DISTINCT FROM ordered.previous_price
          )
          SELECT DISTINCT ON (changed.element_id)
            changed.element_id AS "elementId",
            changed.price AS value,
            changed.snapshot_date AS "snapshotDate",
            coalesce(changed.source_event_id, event.event_id) AS "eventId",
            changed.element_type AS "elementType",
            CASE
              WHEN changed.snapshot_number = 1 THEN 0
              ELSE changed.previous_price
            END AS "lastValue",
            CASE
              WHEN changed.snapshot_number = 1 THEN 'Start'
              WHEN changed.price > changed.previous_price THEN 'Rise'
              ELSE 'Faller'
            END AS "changeType"
          FROM changed_snapshots changed
          LEFT JOIN fpl.events event
            ON event.season_id = changed.season_id
           AND event.deadline_time::date = changed.snapshot_date
          ORDER BY changed.element_id, changed.snapshot_date DESC
        `);
        return rows.map(mapPlayerValueAsOf);
      } catch (error) {
        logError('Failed to get latest player values by player IDs', error, {
          season: season.seasonCode,
          count: elementIds.length,
          fromChangeDate,
          beforeChangeDate,
          asOf: asOf?.toISOString(),
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
