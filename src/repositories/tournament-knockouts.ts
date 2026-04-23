import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentKnockouts,
  type DbTournamentKnockout,
  type DbTournamentKnockoutInsert,
} from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type { SeedPair } from '../domain/tournament';
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

    findRoundOne: async (
      tournamentId: number,
    ): Promise<Array<{ matchId: number; homeEntryId: number | null; awayEntryId: number | null }>> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            matchId: tournamentKnockouts.matchId,
            homeEntryId: tournamentKnockouts.homeEntryId,
            awayEntryId: tournamentKnockouts.awayEntryId,
          })
          .from(tournamentKnockouts)
          .where(
            and(
              eq(tournamentKnockouts.tournamentId, tournamentId),
              eq(tournamentKnockouts.round, 1),
            ),
          )
          .orderBy(tournamentKnockouts.matchId);
        return rows;
      } catch (error) {
        logError('Failed to retrieve round one knockouts', error, { tournamentId });
        throw new DatabaseError(
          'Failed to retrieve round one knockouts',
          'TOURNAMENT_KNOCKOUT_ROUND_ONE_ERROR',
          error as Error,
        );
      }
    },

    seedRoundOneBulk: async (
      tournamentId: number,
      pairs: ReadonlyArray<{ matchId: number; pair: SeedPair }>,
    ): Promise<number> => {
      if (pairs.length === 0) {
        return 0;
      }

      try {
        const client = await getDbClient();
        const matchIds = pairs.map((p) => p.matchId);
        const homeIds = pairs.map((p) => p.pair.homeEntryId);
        const awayIds = pairs.map((p) => p.pair.awayEntryId);

        await client`
          update tournament_knockouts as tk
          set home_entry_id = data.home_entry_id,
              away_entry_id = data.away_entry_id,
              updated_at = now()
          from (
            select
              unnest(${matchIds}::int[]) as match_id,
              unnest(${homeIds}::int[]) as home_entry_id,
              unnest(${awayIds}::int[]) as away_entry_id
          ) as data
          where tk.tournament_id = ${tournamentId}
            and tk.match_id = data.match_id
        `;

        logInfo('Seeded knockout round one', { tournamentId, count: pairs.length });
        return pairs.length;
      } catch (error) {
        logError('Failed to seed knockout round one', error, { tournamentId });
        throw new DatabaseError(
          'Failed to seed knockout round one',
          'TOURNAMENT_KNOCKOUT_SEED_ERROR',
          error as Error,
        );
      }
    },

    deleteByTournament: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentKnockouts)
          .where(eq(tournamentKnockouts.tournamentId, tournamentId));
      } catch (error) {
        logError('Failed to delete tournament knockouts', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament knockouts',
          'TOURNAMENT_KNOCKOUT_DELETE_ERROR',
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
