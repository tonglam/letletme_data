import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  tournamentKnockoutResultsInCompetition,
  type DbTournamentKnockoutResult,
  type DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { SeedPair } from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { assertMutationLockHealthy } from '../utils/mutation-lock';

export const createTournamentKnockoutResultsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());
  const mapResult = (
    row: typeof tournamentKnockoutResultsInCompetition.$inferSelect,
  ): DbTournamentKnockoutResult => ({ ...row, id: row.sourceResultId });

  return {
    findByTournamentAndEvent: async (
      season: FplSeasonRef,
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentKnockoutResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockoutResultsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutResultsInCompetition.tournamentId, tournamentId),
              eq(tournamentKnockoutResultsInCompetition.eventId, eventId),
            ),
          )
          .orderBy(tournamentKnockoutResultsInCompetition.matchId);
        logInfo('Retrieved tournament knockout results', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows.map(mapResult);
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
      season: FplSeasonRef,
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
          .from(tournamentKnockoutResultsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutResultsInCompetition.tournamentId, tournamentId),
              inArray(tournamentKnockoutResultsInCompetition.matchId, uniqueIds),
            ),
          );
        logInfo('Retrieved tournament knockout results by match', {
          tournamentId,
          count: rows.length,
        });
        return rows.map(mapResult);
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
      season: FplSeasonRef,
      tournamentId: number,
      assignments: ReadonlyArray<{ matchId: number; playAgainstId: number; pair: SeedPair }>,
    ): Promise<number> => {
      if (assignments.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        const payload = JSON.stringify(
          assignments.map(({ matchId, playAgainstId, pair }) => ({
            match_id: matchId,
            play_against_id: playAgainstId,
            home_entry_id: pair.homeEntryId,
            away_entry_id: pair.awayEntryId,
          })),
        );
        await db.execute(sql`
          UPDATE ${tournamentKnockoutResultsInCompetition} AS result
          SET home_entry_id = data.home_entry_id,
              away_entry_id = data.away_entry_id,
              updated_at = clock_timestamp()
          FROM jsonb_to_recordset(${payload}::jsonb) AS data(
            match_id int,
            play_against_id int,
            home_entry_id int,
            away_entry_id int
          )
          WHERE result.season_id = ${season.seasonId}
            AND result.tournament_id = ${tournamentId}
            AND result.match_id = data.match_id
            AND result.play_against_id = data.play_against_id
        `);

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

    deleteByTournament: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        assertMutationLockHealthy();
        await db
          .delete(tournamentKnockoutResultsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutResultsInCompetition.tournamentId, tournamentId),
            ),
          );
      } catch (error) {
        logError('Failed to delete tournament knockout results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament knockout results',
          'TOURNAMENT_KNOCKOUT_RESULTS_DELETE_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      results: DbTournamentKnockoutResultInsert[],
    ): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        assertMutationLockHealthy();
        await db
          .insert(tournamentKnockoutResultsInCompetition)
          .values(
            results.map((result) => {
              const { id: _id, ...value } = result as DbTournamentKnockoutResultInsert & {
                id?: number;
              };
              return { ...value, seasonId: season.seasonId };
            }),
          )
          .onConflictDoUpdate({
            target: [
              tournamentKnockoutResultsInCompetition.tournamentId,
              tournamentKnockoutResultsInCompetition.eventId,
              tournamentKnockoutResultsInCompetition.matchId,
              tournamentKnockoutResultsInCompetition.playAgainstId,
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
