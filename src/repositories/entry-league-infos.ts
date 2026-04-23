import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { entryLeagueInfos, type DbEntryLeagueInfoInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryLeagues } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createEntryLeagueInfoRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertFromLeagues: async (entryId: number, leagues?: RawFPLEntryLeagues): Promise<void> => {
      if (!leagues) return; // nothing to do
      try {
        const db = await getDbInstance();
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
        if (rows.length === 0) {
          return;
        }

        await db
          .insert(entryLeagueInfos)
          .values(rows)
          .onConflictDoUpdate({
            target: [entryLeagueInfos.entryId, entryLeagueInfos.leagueId],
            set: {
              leagueName: sql`excluded.league_name`,
              leagueType: sql`excluded.league_type`,
              startedEvent: sql`excluded.started_event`,
              entryRank: sql`excluded.entry_rank`,
              entryLastRank: sql`excluded.entry_last_rank`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted entry league infos', {
          entryId,
          count: rows.length,
        });
      } catch (error) {
        logError('Failed to upsert entry league infos', error, { entryId });
        throw new DatabaseError(
          'Failed to upsert entry league infos',
          'ENTRY_LEAGUE_INFO_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const entryLeagueInfoRepository = createEntryLeagueInfoRepository();
