import { sql } from 'drizzle-orm';
import { entryHistoryInfos, type DbEntryHistoryInfoInsert } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { RawFPLEntryHistoryResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

// No-op helper removed: we only persist past seasons (e.g., "2016/17")

export const createEntryHistoryInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertFromHistory: async (
      entryId: number,
      history: RawFPLEntryHistoryResponse,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const rows: DbEntryHistoryInfoInsert[] = history.past.map((past) => ({
          entryId,
          season: past.season_name,
          totalPoints: past.total_points ?? 0,
          overallRank: past.rank ?? 0,
        }));
        if (rows.length === 0) {
          return;
        }

        await db
          .insert(entryHistoryInfos)
          .values(rows)
          .onConflictDoUpdate({
            target: [entryHistoryInfos.entryId, entryHistoryInfos.season],
            set: {
              totalPoints: sql`excluded.total_points`,
              overallRank: sql`excluded.overall_rank`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted entry history past seasons', {
          entryId,
          count: rows.length,
        });
      } catch (error) {
        logError('Failed to upsert entry history info', error, { entryId });
        throw new DatabaseError(
          'Failed to upsert entry history info',
          'ENTRY_HISTORY_INFO_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const entryHistoryInfoRepository = createEntryHistoryInfoRepository();
