import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  entriesInCompetition,
  type DbEntryInfo,
  type DbEntryInfoInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntrySummary } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type EntryStorage = typeof entriesInCompetition.$inferSelect;

function uniqueNames(names: (string | null | undefined)[]): string[] {
  const result: string[] = [];
  for (const name of names) {
    if (name && !result.includes(name)) result.push(name);
  }
  return result;
}

function mapEntry(row: EntryStorage, season: FplSeasonRef): DbEntryInfo {
  return {
    ...row,
    id: row.entryId,
    entrySnapshotSyncedThroughEventId: row.snapshotSyncedThroughEventId,
    entrySnapshotSyncedSeason: season.seasonCode,
    entryTransfersSyncedThroughEventId: row.transfersSyncedThroughEventId,
    entryTransfersSyncedSeason: season.seasonCode,
    entryTransfersSourceCheckedAt: row.transfersSourceCheckedAt,
  };
}

export const createEntryInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findAll: async (season: FplSeasonRef): Promise<DbEntryInfo[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(entriesInCompetition)
          .where(eq(entriesInCompetition.seasonId, season.seasonId));
        return rows.map((row) => mapEntry(row, season));
      } catch (error) {
        logError('Failed to retrieve all entry infos', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve all entry infos',
          'ENTRY_INFO_FIND_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByIds: async (season: FplSeasonRef, ids: number[]): Promise<DbEntryInfo[]> => {
      if (ids.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(ids));
        const results: DbEntryInfo[] = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          const chunk = uniqueIds.slice(index, index + 1000);
          const rows = await db
            .select()
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                inArray(entriesInCompetition.entryId, chunk),
              ),
            );
          results.push(...rows.map((row) => mapEntry(row, season)));
        }
        return results;
      } catch (error) {
        logError('Failed to retrieve entry infos by ids', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve entry infos',
          'ENTRY_INFO_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findIdsNeedingSnapshotSync: async (
      season: FplSeasonRef,
      ids: number[],
      targetEventId: number,
    ): Promise<number[]> => {
      if (ids.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(ids));
        const results: number[] = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          const chunk = uniqueIds.slice(index, index + 1000);
          const rows = await db
            .select({
              entryId: entriesInCompetition.entryId,
              syncedThroughEventId: entriesInCompetition.snapshotSyncedThroughEventId,
            })
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                inArray(entriesInCompetition.entryId, chunk),
              ),
            );
          const checkpoints = new Map(
            rows.map((row) => [row.entryId, row.syncedThroughEventId] as const),
          );
          results.push(
            ...chunk.filter((id) => {
              const checkpoint = checkpoints.get(id);
              return checkpoint === undefined || checkpoint === null || checkpoint < targetEventId;
            }),
          );
        }
        return results;
      } catch (error) {
        logError('Failed to find entry snapshot sync gaps', error, {
          season: season.seasonCode,
          count: ids.length,
          targetEventId,
        });
        throw new DatabaseError(
          'Failed to find entry snapshot sync gaps',
          'ENTRY_INFO_SYNC_GAPS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertFromSummary: async (
      season: FplSeasonRef,
      summary: RawFPLEntrySummary,
      lastEventId?: number | null,
      snapshotSyncedThroughEventId?: number | null,
    ): Promise<DbEntryInfo> => {
      try {
        const db = await getDbInstance();
        const currentEntryName = summary.name;
        const playerName = `${summary.player_first_name} ${summary.player_last_name}`.trim();
        const currentTeamValue = summary.last_deadline_value ?? summary.value ?? null;
        const currentBank = summary.last_deadline_bank ?? summary.bank ?? null;
        const insert: DbEntryInfoInsert = {
          seasonId: season.seasonId,
          entryId: summary.id,
          entryName: currentEntryName,
          playerName,
          region: summary.player_region_name ?? null,
          startedEvent: summary.started_event ?? null,
          overallPoints: summary.summary_overall_points ?? null,
          overallRank: summary.summary_overall_rank ?? null,
          bank: currentBank,
          lastBank: 0,
          lastEventId: lastEventId ?? 0,
          snapshotSyncedThroughEventId: snapshotSyncedThroughEventId ?? null,
          teamValue: currentTeamValue,
          totalTransfers: summary.last_deadline_total_transfers ?? null,
          lastEntryName: null,
          lastOverallPoints: 0,
          lastOverallRank: 0,
          lastTeamValue: 0,
          usedEntryNames: uniqueNames([currentEntryName]),
        };

        const result = await db
          .insert(entriesInCompetition)
          .values(insert)
          .onConflictDoUpdate({
            target: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
            set: {
              entryName: insert.entryName,
              playerName: insert.playerName,
              region: insert.region,
              startedEvent: insert.startedEvent,
              overallPoints: insert.overallPoints,
              overallRank: insert.overallRank,
              totalTransfers: insert.totalTransfers,
              bank: sql`COALESCE(excluded.bank, ${entriesInCompetition.bank})`,
              teamValue: sql`COALESCE(excluded.team_value, ${entriesInCompetition.teamValue})`,
              lastEventId: sql`GREATEST(${entriesInCompetition.lastEventId}, excluded.last_event_id)`,
              snapshotSyncedThroughEventId: sql`
                CASE
                  WHEN excluded.snapshot_synced_through_event_id IS NULL
                    THEN ${entriesInCompetition.snapshotSyncedThroughEventId}
                  ELSE GREATEST(
                    COALESCE(${entriesInCompetition.snapshotSyncedThroughEventId}, 0),
                    excluded.snapshot_synced_through_event_id
                  )
                END
              `,
              lastBank: sql`COALESCE(${entriesInCompetition.bank}, 0)`,
              lastEntryName: sql`${entriesInCompetition.entryName}`,
              lastOverallPoints: sql`COALESCE(${entriesInCompetition.overallPoints}, 0)`,
              lastOverallRank: sql`COALESCE(${entriesInCompetition.overallRank}, 0)`,
              lastTeamValue: sql`COALESCE(${entriesInCompetition.teamValue}, 0)`,
              usedEntryNames: sql`
                (
                  SELECT COALESCE(array_agg(name ORDER BY first_idx), '{}'::text[])
                  FROM (
                    SELECT name, MIN(idx) AS first_idx
                    FROM unnest(
                      COALESCE(${entriesInCompetition.usedEntryNames}, '{}'::text[])
                      || excluded.used_entry_names
                      || CASE
                           WHEN ${entriesInCompetition.entryName} IS DISTINCT FROM excluded.entry_name
                           THEN ARRAY[${entriesInCompetition.entryName}]
                           ELSE '{}'::text[]
                         END
                    ) WITH ORDINALITY AS names(name, idx)
                    WHERE name IS NOT NULL AND name <> ''
                    GROUP BY name
                  ) dedup
                )
              `,
              updatedAt: new Date(),
            },
          })
          .returning();

        const row = result[0];
        logInfo('Upserted entry info', {
          season: season.seasonCode,
          entryId: row.entryId,
          entryName: row.entryName,
        });
        return mapEntry(row, season);
      } catch (error) {
        logError('Failed to upsert entry info', error, {
          season: season.seasonCode,
          entryId: summary.id,
        });
        throw new DatabaseError(
          'Failed to upsert entry info',
          'ENTRY_INFO_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryInfoRepository = createEntryInfoRepository();
