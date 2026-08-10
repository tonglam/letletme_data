import { sql } from 'drizzle-orm';

import { entryLeaguesInCompetition } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryLeagues } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export const createEntryLeagueInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    upsertFromLeagues: async (
      season: FplSeasonRef,
      entryId: number,
      leagues?: RawFPLEntryLeagues,
    ): Promise<void> => {
      if (!leagues) return;

      try {
        const db = await getDbInstance();
        const rows = [
          ...(leagues.classic ?? []).map((item) => ({ item, leagueType: 'classic' as const })),
          ...(leagues.h2h ?? []).map((item) => ({ item, leagueType: 'h2h' as const })),
        ].map(({ item, leagueType }) => ({
          seasonId: season.seasonId,
          entryId,
          leagueId: item.id,
          leagueName: item.name,
          leagueType,
          startedEvent: item.start_event ?? null,
          entryRank: item.entry_rank ?? null,
          entryLastRank: item.entry_last_rank ?? null,
        }));
        if (rows.length === 0) return;

        await db
          .insert(entryLeaguesInCompetition)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              entryLeaguesInCompetition.seasonId,
              entryLeaguesInCompetition.entryId,
              entryLeaguesInCompetition.leagueId,
              entryLeaguesInCompetition.leagueType,
            ],
            set: {
              leagueName: sql`excluded.league_name`,
              startedEvent: sql`excluded.started_event`,
              entryRank: sql`excluded.entry_rank`,
              entryLastRank: sql`excluded.entry_last_rank`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted entry league infos', {
          season: season.seasonCode,
          entryId,
          count: rows.length,
        });
      } catch (error) {
        logError('Failed to upsert entry league infos', error, {
          season: season.seasonCode,
          entryId,
        });
        throw new DatabaseError(
          'Failed to upsert entry league infos',
          'ENTRY_LEAGUE_INFO_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryLeagueInfoRepository = createEntryLeagueInfoRepository();
