import { inArray, sql } from 'drizzle-orm';
import { entryInfos, type DbEntryInfo, type DbEntryInfoInsert } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { RawFPLEntrySummary } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

function uniqueNames(names: (string | null | undefined)[]): string[] {
  const result: string[] = [];
  for (const n of names) {
    if (!n) continue;
    if (!result.includes(n)) result.push(n);
  }
  return result;
}

export const createEntryInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findAll: async (): Promise<DbEntryInfo[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db.select().from(entryInfos);
        logInfo('Retrieved all entry infos', { count: rows.length });
        return rows;
      } catch (error) {
        logError('Failed to retrieve all entry infos', error);
        throw new DatabaseError(
          'Failed to retrieve all entry infos',
          'ENTRY_INFO_FIND_ALL_ERROR',
          error as Error,
        );
      }
    },

    findByIds: async (ids: number[]): Promise<DbEntryInfo[]> => {
      if (ids.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(ids));
        const chunks: number[][] = [];

        for (let index = 0; index < uniqueIds.length; index += 1000) {
          chunks.push(uniqueIds.slice(index, index + 1000));
        }

        const results: DbEntryInfo[] = [];
        for (const chunk of chunks) {
          const rows = await db.select().from(entryInfos).where(inArray(entryInfos.id, chunk));
          results.push(...rows);
        }

        logInfo('Retrieved entry infos by ids', { count: results.length });
        return results;
      } catch (error) {
        logError('Failed to retrieve entry infos by ids', error);
        throw new DatabaseError(
          'Failed to retrieve entry infos',
          'ENTRY_INFO_FIND_ERROR',
          error as Error,
        );
      }
    },

    upsertFromSummary: async (
      summary: RawFPLEntrySummary,
      lastEventId?: number | null,
    ): Promise<DbEntryInfo> => {
      try {
        const db = await getDbInstance();

        const currentEntryName = summary.name;
        const playerName = `${summary.player_first_name} ${summary.player_last_name}`.trim();

        // Determine current snapshot values from summary
        const currentTeamValue = summary.last_deadline_value ?? summary.value ?? null;
        const currentBank = summary.last_deadline_bank ?? summary.bank ?? null;
        const currentOverallPoints = summary.summary_overall_points ?? null;
        const currentOverallRank = summary.summary_overall_rank ?? null;

        // Insert-path values (no pre-existing row): last_* start at 0/null.
        // On conflict, the SET clause computes last_* in SQL from the
        // pre-update row — no read-modify-write, so concurrent upserts chain
        // correctly off each other's committed state.
        const insert: DbEntryInfoInsert = {
          id: summary.id,
          entryName: currentEntryName,
          playerName,
          region: summary.player_region_name ?? null,
          startedEvent: summary.started_event ?? null,
          overallPoints: currentOverallPoints,
          overallRank: currentOverallRank,
          // Monetary fields are stored as tenths (raw ints from FPL summary last_deadline_*)
          bank: currentBank,
          lastBank: 0,
          // null means "no known current event" — must stay null on insert so the
          // ON CONFLICT COALESCE can fall through to the existing last_event_id
          // instead of materializing 0 and wiping progress (Codex P2).
          lastEventId: lastEventId ?? null,
          teamValue: currentTeamValue,
          totalTransfers: summary.last_deadline_total_transfers ?? null,
          lastEntryName: null,
          lastOverallPoints: 0,
          lastOverallRank: 0,
          lastTeamValue: 0,
          usedEntryNames: uniqueNames([currentEntryName]),
        };

        const result = await db
          .insert(entryInfos)
          .values(insert)
          .onConflictDoUpdate({
            target: entryInfos.id,
            set: {
              entryName: insert.entryName,
              playerName: insert.playerName,
              region: insert.region,
              startedEvent: insert.startedEvent,
              overallPoints: insert.overallPoints,
              overallRank: insert.overallRank,
              totalTransfers: insert.totalTransfers,
              // Keep the stored value when the summary carries no new one
              bank: sql`COALESCE(excluded.bank, ${entryInfos.bank})`,
              teamValue: sql`COALESCE(excluded.team_value, ${entryInfos.teamValue})`,
              lastEventId: sql`COALESCE(excluded.last_event_id, ${entryInfos.lastEventId}, 0)`,
              // Snapshot the pre-update row into last_* (table-qualified
              // references in DO UPDATE read the existing row, not excluded)
              lastBank: sql`COALESCE(${entryInfos.bank}, 0)`,
              lastEntryName: sql`${entryInfos.entryName}`,
              lastOverallPoints: sql`COALESCE(${entryInfos.overallPoints}, 0)`,
              lastOverallRank: sql`COALESCE(${entryInfos.overallRank}, 0)`,
              lastTeamValue: sql`COALESCE(${entryInfos.teamValue}, 0)`,
              // Prior names + current name + previous entry_name when renamed;
              // uniqueNames semantics (first occurrence wins, drop empty)
              usedEntryNames: sql`
                (
                  SELECT COALESCE(array_agg(name ORDER BY first_idx), '{}'::text[])
                  FROM (
                    SELECT name, MIN(idx) AS first_idx
                    FROM unnest(
                      COALESCE(${entryInfos.usedEntryNames}, '{}'::text[])
                      || excluded.used_entry_names
                      || CASE
                           WHEN ${entryInfos.entryName} IS DISTINCT FROM excluded.entry_name
                           THEN ARRAY[${entryInfos.entryName}]
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
        logInfo('Upserted entry info', { id: row.id, entryName: row.entryName });
        return row;
      } catch (error) {
        logError('Failed to upsert entry info', error, { id: summary.id });
        throw new DatabaseError(
          'Failed to upsert entry info',
          'ENTRY_INFO_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const entryInfoRepository = createEntryInfoRepository();
