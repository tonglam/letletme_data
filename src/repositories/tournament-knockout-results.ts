import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentKnockoutResults,
  type DbTournamentKnockoutResult,
  type DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type { SeedPair } from '../domain/tournament';
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

    seedRoundOneResultsBulk: async (
      tournamentId: number,
      assignments: ReadonlyArray<{ matchId: number; playAgainstId: number; pair: SeedPair }>,
    ): Promise<number> => {
      if (assignments.length === 0) {
        return 0;
      }

      try {
        const client = await getDbClient();
        const matchIds = assignments.map((a) => a.matchId);
        const playAgainstIds = assignments.map((a) => a.playAgainstId);
        const homeIds = assignments.map((a) => a.pair.homeEntryId);
        const awayIds = assignments.map((a) => a.pair.awayEntryId);

        await client`
          update tournament_knockout_results as tkr
          set home_entry_id = data.home_entry_id,
              away_entry_id = data.away_entry_id,
              updated_at = now()
          from (
            select
              unnest(${matchIds}::int[]) as match_id,
              unnest(${playAgainstIds}::int[]) as play_against_id,
              unnest(${homeIds}::int[]) as home_entry_id,
              unnest(${awayIds}::int[]) as away_entry_id
          ) as data
          where tkr.tournament_id = ${tournamentId}
            and tkr.match_id = data.match_id
            and tkr.play_against_id = data.play_against_id
        `;

        logInfo('Seeded knockout round one results', { tournamentId, count: assignments.length });
        return assignments.length;
      } catch (error) {
        logError('Failed to seed knockout round one results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to seed knockout round one results',
          'TOURNAMENT_KNOCKOUT_RESULTS_SEED_ERROR',
          error as Error,
        );
      }
    },

    deleteByTournament: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentKnockoutResults)
          .where(eq(tournamentKnockoutResults.tournamentId, tournamentId));
      } catch (error) {
        logError('Failed to delete tournament knockout results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament knockout results',
          'TOURNAMENT_KNOCKOUT_RESULTS_DELETE_ERROR',
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
