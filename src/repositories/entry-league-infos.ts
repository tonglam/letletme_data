import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { entryLeagueInfos, type DbEntryLeagueInfoInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryLeagues } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EntryLeagueInfoRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async upsertFromLeagues(entryId: number, leagues?: RawFPLEntryLeagues): Promise<void> {
    if (!leagues) return; // nothing to do
    try {
      const db = await this.getDbInstance();
      const rows: DbEntryLeagueInfoInsert[] = [];

      for (const item of leagues.classic || []) {
        rows.push({
          entryId,
          leagueId: item.id,
          leagueName: item.name,
          leagueType: 'classic',
          startedEvent: item.start_event ?? null,
          entryRank: item.entry_rank ?? null,
          entryLastRank: item.entry_last_rank ?? null,
        });
      }

      for (const item of leagues.h2h || []) {
        rows.push({
          entryId,
          leagueId: item.id,
          leagueName: item.name,
          leagueType: 'h2h',
          startedEvent: item.start_event ?? null,
          entryRank: item.entry_rank ?? null,
          entryLastRank: item.entry_last_rank ?? null,
        });
      }

      for (const insert of rows) {
        await db
          .insert(entryLeagueInfos)
          .values(insert)
          .onConflictDoUpdate({
            target: [entryLeagueInfos.entryId, entryLeagueInfos.leagueId],
            set: {
              leagueName: insert.leagueName,
              leagueType: insert.leagueType,
              startedEvent: insert.startedEvent,
              entryRank: insert.entryRank,
              entryLastRank: insert.entryLastRank,
            },
          });
        logInfo('Upserted entry league info', {
          entryId: insert.entryId,
          leagueId: insert.leagueId,
          leagueType: insert.leagueType,
        });
      }
    } catch (error) {
      logError('Failed to upsert entry league infos', error, { entryId });
      throw new DatabaseError(
        'Failed to upsert entry league infos',
        'ENTRY_LEAGUE_INFO_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryLeagueInfoRepository = new EntryLeagueInfoRepository();

