import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentKnockouts,
  type DbTournamentKnockout,
  type DbTournamentKnockoutInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentKnockoutsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByTournamentAndEndedEvent: async (
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentKnockout[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockouts)
          .where(
            and(
              eq(tournamentKnockouts.tournamentId, tournamentId),
              eq(tournamentKnockouts.endedEventId, eventId),
            ),
          )
          .orderBy(tournamentKnockouts.matchId);
        logInfo('Retrieved tournament knockouts for event', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament knockouts for event', error, {
          tournamentId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament knockouts for event',
          'TOURNAMENT_KNOCKOUT_FIND_ERROR',
          error as Error,
        );
      }
    },

    findByTournamentAndRound: async (
      tournamentId: number,
      round: number,
    ): Promise<DbTournamentKnockout[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockouts)
          .where(
            and(
              eq(tournamentKnockouts.tournamentId, tournamentId),
              eq(tournamentKnockouts.round, round),
            ),
          )
          .orderBy(tournamentKnockouts.matchId);
        logInfo('Retrieved tournament knockouts by round', {
          tournamentId,
          round,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament knockouts by round', error, {
          tournamentId,
          round,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament knockouts by round',
          'TOURNAMENT_KNOCKOUT_FIND_ERROR',
          error as Error,
        );
      }
    },

    findByTournamentAndMatchIds: async (
      tournamentId: number,
      matchIds: number[],
    ): Promise<DbTournamentKnockout[]> => {
      if (matchIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(matchIds));
        const rows = await db
          .select()
          .from(tournamentKnockouts)
          .where(
            and(
              eq(tournamentKnockouts.tournamentId, tournamentId),
              inArray(tournamentKnockouts.matchId, uniqueIds),
            ),
          );
        logInfo('Retrieved tournament knockouts by match', {
          tournamentId,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament knockouts by match', error, {
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament knockouts by match',
          'TOURNAMENT_KNOCKOUT_FIND_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (records: DbTournamentKnockoutInsert[]): Promise<number> => {
      if (records.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentKnockouts)
          .values(records)
          .onConflictDoUpdate({
            target: [tournamentKnockouts.tournamentId, tournamentKnockouts.matchId],
            set: {
              homeEntryId: sql`excluded.home_entry_id`,
              homeNetPoints: sql`excluded.home_net_points`,
              homeGoalsScored: sql`excluded.home_goals_scored`,
              homeGoalsConceded: sql`excluded.home_goals_conceded`,
              homeWins: sql`excluded.home_wins`,
              awayEntryId: sql`excluded.away_entry_id`,
              awayNetPoints: sql`excluded.away_net_points`,
              awayGoalsScored: sql`excluded.away_goals_scored`,
              awayGoalsConceded: sql`excluded.away_goals_conceded`,
              awayWins: sql`excluded.away_wins`,
              roundWinner: sql`excluded.round_winner`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted tournament knockouts', { count: records.length });
        return records.length;
      } catch (error) {
        logError('Failed to upsert tournament knockouts', error, { count: records.length });
        throw new DatabaseError(
          'Failed to upsert tournament knockouts',
          'TOURNAMENT_KNOCKOUT_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentKnockoutsRepository = createTournamentKnockoutsRepository();
