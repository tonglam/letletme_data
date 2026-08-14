import { and, eq, not, or, sql } from 'drizzle-orm';

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
      const startedAt = performance.now();
      if (!leagues) {
        logInfo('Entry league source was not present; retained the previous snapshot', {
          season: season.seasonCode,
          sourcePresent: false,
          incomingRows: 0,
          removedRows: 0,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }

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

        if (rows.length > 0) {
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
        }

        const scope = and(
          eq(entryLeaguesInCompetition.seasonId, season.seasonId),
          eq(entryLeaguesInCompetition.entryId, entryId),
        );
        const retainedRows = rows.map((row) =>
          and(
            eq(entryLeaguesInCompetition.leagueId, row.leagueId),
            eq(entryLeaguesInCompetition.leagueType, row.leagueType),
          ),
        );
        const retainedPredicate = or(...retainedRows);
        const removed = await db
          .delete(entryLeaguesInCompetition)
          .where(retainedPredicate ? and(scope, not(retainedPredicate)) : scope)
          .returning({
            leagueId: entryLeaguesInCompetition.leagueId,
          });

        logInfo('Replaced entry league snapshot', {
          season: season.seasonCode,
          sourcePresent: true,
          incomingRows: rows.length,
          removedRows: removed.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        logError('Failed to replace entry league snapshot', error, {
          season: season.seasonCode,
          sourcePresent: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        throw new DatabaseError(
          'Failed to replace entry league snapshot',
          'ENTRY_LEAGUE_INFO_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryLeagueInfoRepository = createEntryLeagueInfoRepository();
