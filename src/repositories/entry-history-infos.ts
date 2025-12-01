import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryHistoryInfos,
  type DbEntryHistoryInfo,
  type DbEntryHistoryInfoInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryHistoryResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

// No-op helper removed: we only persist past seasons (e.g., "2016/17")

export class EntryHistoryInfoRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async upsertFromHistory(entryId: number, history: RawFPLEntryHistoryResponse): Promise<void> {
    try {
      const db = await this.getDbInstance();

      // Upsert past seasons from API (use season_name as-is: "YYYY/YY")
      for (const past of history.past) {
        const season = past.season_name;
        const totalPoints = past.total_points ?? 0;
        const overallRank = past.rank ?? 0;

        const insert: DbEntryHistoryInfoInsert = {
          entryId,
          season,
          totalPoints,
          overallRank,
        };

        await db
          .insert(entryHistoryInfos)
          .values(insert)
          .onConflictDoUpdate({
            target: [entryHistoryInfos.entryId, entryHistoryInfos.season],
            set: { totalPoints, overallRank },
          });

        logInfo('Upserted entry history past season', {
          entryId,
          season,
          totalPoints,
          overallRank,
        });
      }
    } catch (error) {
      logError('Failed to upsert entry history info', error, { entryId });
      throw new DatabaseError(
        'Failed to upsert entry history info',
        'ENTRY_HISTORY_INFO_UPSERT_ERROR',
        error as Error,
      );
    }
  }

  async findByEntryAndSeason(entryId: number, season: string): Promise<DbEntryHistoryInfo | null> {
    try {
      const db = await this.getDbInstance();
      const res = await db
        .select()
        .from(entryHistoryInfos)
        .where(and(eq(entryHistoryInfos.entryId, entryId), eq(entryHistoryInfos.season, season)));
      return res[0] || null;
    } catch (error) {
      logError('Failed to find entry history info', error, { entryId, season });
      throw new DatabaseError(
        'Failed to retrieve entry history info',
        'ENTRY_HISTORY_INFO_FIND_ERROR',
        error as Error,
      );
    }
  }
}

export const entryHistoryInfoRepository = new EntryHistoryInfoRepository();
