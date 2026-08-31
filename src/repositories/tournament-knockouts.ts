import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  tournamentKnockoutsInCompetition,
  type DbTournamentKnockout,
  type DbTournamentKnockoutInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { SeedPair } from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type TournamentKnockoutUpsertOptions = {
  /** Local bracket match IDs returned by the provider in this fetch. */
  fetchedMatchIds?: readonly number[];
  /** Checkpoint to use for bracket rows returned by the provider. */
  checkedAt?: Date;
};

export const createTournamentKnockoutsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());
  const mapKnockout = (
    row: typeof tournamentKnockoutsInCompetition.$inferSelect,
  ): DbTournamentKnockout => ({ ...row, id: row.sourceKnockoutId });

  return {
    findByTournamentAndEndedEvent: async (
      season: FplSeasonRef,
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentKnockout[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockoutsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutsInCompetition.tournamentId, tournamentId),
              eq(tournamentKnockoutsInCompetition.endedEventId, eventId),
            ),
          )
          .orderBy(tournamentKnockoutsInCompetition.matchId);
        logInfo('Retrieved tournament knockouts for event', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows.map(mapKnockout);
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
      season: FplSeasonRef,
      tournamentId: number,
      round: number,
    ): Promise<DbTournamentKnockout[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentKnockoutsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutsInCompetition.tournamentId, tournamentId),
              eq(tournamentKnockoutsInCompetition.round, round),
            ),
          )
          .orderBy(tournamentKnockoutsInCompetition.matchId);
        logInfo('Retrieved tournament knockouts by round', {
          tournamentId,
          round,
          count: rows.length,
        });
        return rows.map(mapKnockout);
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
      season: FplSeasonRef,
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
          .from(tournamentKnockoutsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutsInCompetition.tournamentId, tournamentId),
              inArray(tournamentKnockoutsInCompetition.matchId, uniqueIds),
            ),
          );
        logInfo('Retrieved tournament knockouts by match', {
          tournamentId,
          count: rows.length,
        });
        return rows.map(mapKnockout);
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
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<
      Array<{ matchId: number; homeEntryId: number | null; awayEntryId: number | null }>
    > => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            matchId: tournamentKnockoutsInCompetition.matchId,
            homeEntryId: tournamentKnockoutsInCompetition.homeEntryId,
            awayEntryId: tournamentKnockoutsInCompetition.awayEntryId,
          })
          .from(tournamentKnockoutsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutsInCompetition.tournamentId, tournamentId),
              eq(tournamentKnockoutsInCompetition.round, 1),
            ),
          )
          .orderBy(tournamentKnockoutsInCompetition.matchId);
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
      season: FplSeasonRef,
      tournamentId: number,
      pairs: ReadonlyArray<{ matchId: number; pair: SeedPair }>,
    ): Promise<number> => {
      if (pairs.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        const payload = JSON.stringify(
          pairs.map(({ matchId, pair }) => ({
            match_id: matchId,
            home_entry_id: pair.homeEntryId,
            away_entry_id: pair.awayEntryId,
          })),
        );
        await db.execute(sql`
          UPDATE ${tournamentKnockoutsInCompetition} AS knockout
          SET home_entry_id = data.home_entry_id,
              away_entry_id = data.away_entry_id,
              updated_at = clock_timestamp()
          FROM jsonb_to_recordset(${payload}::jsonb) AS data(
            match_id int,
            home_entry_id int,
            away_entry_id int
          )
          WHERE knockout.season_id = ${season.seasonId}
            AND knockout.tournament_id = ${tournamentId}
            AND knockout.match_id = data.match_id
        `);

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

    deleteByTournament: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentKnockoutsInCompetition)
          .where(
            and(
              eq(tournamentKnockoutsInCompetition.seasonId, season.seasonId),
              eq(tournamentKnockoutsInCompetition.tournamentId, tournamentId),
            ),
          );
      } catch (error) {
        logError('Failed to delete tournament knockouts', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament knockouts',
          'TOURNAMENT_KNOCKOUT_DELETE_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      records: DbTournamentKnockoutInsert[],
      options: TournamentKnockoutUpsertOptions = {},
    ): Promise<number> => {
      if (records.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        const fetchedMatchIds = options.fetchedMatchIds?.filter(
          (matchId): matchId is number => Number.isSafeInteger(matchId) && matchId > 0,
        );
        const bracketMatchWasFetched =
          fetchedMatchIds === undefined
            ? sql`TRUE`
            : fetchedMatchIds.length === 0
              ? sql`FALSE`
              : sql`excluded.match_id IN (${sql.join(
                  fetchedMatchIds.map((matchId) => sql`${matchId}`),
                  sql`, `,
                )})`;
        const knockoutPayloadUnchanged = sql`
          ${tournamentKnockoutsInCompetition.round} IS NOT DISTINCT FROM excluded.round
          AND ${tournamentKnockoutsInCompetition.startedEventId} IS NOT DISTINCT FROM excluded.started_event_id
          AND ${tournamentKnockoutsInCompetition.endedEventId} IS NOT DISTINCT FROM excluded.ended_event_id
          AND ${tournamentKnockoutsInCompetition.nextMatchId} IS NOT DISTINCT FROM excluded.next_match_id
          AND ${tournamentKnockoutsInCompetition.homeEntryId} IS NOT DISTINCT FROM excluded.home_entry_id
          AND ${tournamentKnockoutsInCompetition.homeNetPoints} IS NOT DISTINCT FROM excluded.home_net_points
          AND ${tournamentKnockoutsInCompetition.homeGoalsScored} IS NOT DISTINCT FROM excluded.home_goals_scored
          AND ${tournamentKnockoutsInCompetition.homeGoalsConceded} IS NOT DISTINCT FROM excluded.home_goals_conceded
          AND ${tournamentKnockoutsInCompetition.homeWins} IS NOT DISTINCT FROM excluded.home_wins
          AND ${tournamentKnockoutsInCompetition.awayEntryId} IS NOT DISTINCT FROM excluded.away_entry_id
          AND ${tournamentKnockoutsInCompetition.awayNetPoints} IS NOT DISTINCT FROM excluded.away_net_points
          AND ${tournamentKnockoutsInCompetition.awayGoalsScored} IS NOT DISTINCT FROM excluded.away_goals_scored
          AND ${tournamentKnockoutsInCompetition.awayGoalsConceded} IS NOT DISTINCT FROM excluded.away_goals_conceded
          AND ${tournamentKnockoutsInCompetition.awayWins} IS NOT DISTINCT FROM excluded.away_wins
          AND ${tournamentKnockoutsInCompetition.roundWinner} IS NOT DISTINCT FROM excluded.round_winner
        `;
        const changedAt = options.checkedAt ?? new Date();
        await db
          .insert(tournamentKnockoutsInCompetition)
          .values(
            records.map((record) => {
              const { id: _id, ...value } = record as DbTournamentKnockoutInsert & {
                id?: number;
              };
              return {
                ...value,
                seasonId: season.seasonId,
                updatedAt: record.updatedAt ?? changedAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: [
              tournamentKnockoutsInCompetition.tournamentId,
              tournamentKnockoutsInCompetition.matchId,
            ],
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
              updatedAt: sql`CASE
                WHEN ${bracketMatchWasFetched}
                  THEN excluded.updated_at
                WHEN ${knockoutPayloadUnchanged}
                  THEN ${tournamentKnockoutsInCompetition.updatedAt}
                ELSE excluded.updated_at
              END`,
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
