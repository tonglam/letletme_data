import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentKnockoutResults,
  type DbTournamentKnockoutResult,
  type DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentKnockoutResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByTournamentAndEvent: async (
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentKnockoutResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockoutResults)
          .where(
            and(
              eq(tournamentKnockoutResults.tournamentId, tournamentId),
              eq(tournamentKnockoutResults.eventId, eventId),
            ),
          )
          .orderBy(tournamentKnockoutResults.matchId);
        logInfo('Retrieved tournament knockout results', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament knockout results', error, {
          tournamentId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament knockout results',
          'TOURNAMENT_KNOCKOUT_RESULTS_FIND_ERROR',
          error as Error,
        );
      }
    },

    findByTournamentAndMatchIds: async (
      tournamentId: number,
      matchIds: number[],
    ): Promise<DbTournamentKnockoutResult[]> => {
      if (matchIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(matchIds));
        const rows = await db
          .select()
          .from(tournamentKnockoutResults)
          .where(
            and(
              eq(tournamentKnockoutResults.tournamentId, tournamentId),
              inArray(tournamentKnockoutResults.matchId, uniqueIds),
            ),
          );
        logInfo('Retrieved tournament knockout results by match', {
          tournamentId,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament knockout results by match', error, {
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament knockout results by match',
          'TOURNAMENT_KNOCKOUT_RESULTS_MATCH_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (results: DbTournamentKnockoutResultInsert[]): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentKnockoutResults)
          .values(results)
          .onConflictDoUpdate({
            target: [
              tournamentKnockoutResults.tournamentId,
              tournamentKnockoutResults.eventId,
              tournamentKnockoutResults.matchId,
              tournamentKnockoutResults.playAgainstId,
            ],
            set: {
              homeEntryId: sql`excluded.home_entry_id`,
              homeNetPoints: sql`excluded.home_net_points`,
              homeGoalsScored: sql`excluded.home_goals_scored`,
              homeGoalsConceded: sql`excluded.home_goals_conceded`,
              awayEntryId: sql`excluded.away_entry_id`,
              awayNetPoints: sql`excluded.away_net_points`,
              awayGoalsScored: sql`excluded.away_goals_scored`,
              awayGoalsConceded: sql`excluded.away_goals_conceded`,
              matchWinner: sql`excluded.match_winner`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted tournament knockout results', { count: results.length });
        return results.length;
      } catch (error) {
        logError('Failed to upsert tournament knockout results', error, { count: results.length });
        throw new DatabaseError(
          'Failed to upsert tournament knockout results',
          'TOURNAMENT_KNOCKOUT_RESULTS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentKnockoutResultsRepository = createTournamentKnockoutResultsRepository();
