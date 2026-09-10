import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  tournamentPointsGroupResultsInCompetition,
  type DbTournamentPointsGroupResult,
  type DbTournamentPointsGroupResultInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const mapResult = (
  row: typeof tournamentPointsGroupResultsInCompetition.$inferSelect,
): DbTournamentPointsGroupResult => ({ ...row, id: row.sourceResultId });

export const createTournamentPointsGroupResultsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByTournamentAndEvent: async (
      season: FplSeasonRef,
      tournamentId: number,
      eventId: number,
      entryIds: number[],
    ): Promise<DbTournamentPointsGroupResult[]> => {
      if (entryIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(entryIds));
        const chunks: number[][] = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          chunks.push(uniqueIds.slice(index, index + 1000));
        }

        const results: DbTournamentPointsGroupResult[] = [];
        for (const chunk of chunks) {
          const rows = await db
            .select()
            .from(tournamentPointsGroupResultsInCompetition)
            .where(
              and(
                eq(tournamentPointsGroupResultsInCompetition.seasonId, season.seasonId),
                eq(tournamentPointsGroupResultsInCompetition.tournamentId, tournamentId),
                eq(tournamentPointsGroupResultsInCompetition.eventId, eventId),
                inArray(tournamentPointsGroupResultsInCompetition.entryId, chunk),
              ),
            );
          results.push(...rows.map(mapResult));
        }

        logInfo('Retrieved tournament points group results', {
          tournamentId,
          eventId,
          count: results.length,
        });
        return results;
      } catch (error) {
        logError('Failed to retrieve tournament points group results', error, {
          tournamentId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament points group results',
          'TOURNAMENT_POINTS_GROUP_RESULTS_FIND_ERROR',
          error as Error,
        );
      }
    },

    deleteByTournament: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentPointsGroupResultsInCompetition)
          .where(
            and(
              eq(tournamentPointsGroupResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentPointsGroupResultsInCompetition.tournamentId, tournamentId),
            ),
          );
      } catch (error) {
        logError('Failed to delete tournament points group results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament points group results',
          'TOURNAMENT_POINTS_GROUP_RESULTS_DELETE_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      results: DbTournamentPointsGroupResultInsert[],
    ): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentPointsGroupResultsInCompetition)
          .values(results.map((result) => ({ ...result, seasonId: season.seasonId })))
          .onConflictDoUpdate({
            target: [
              tournamentPointsGroupResultsInCompetition.tournamentId,
              tournamentPointsGroupResultsInCompetition.eventId,
              tournamentPointsGroupResultsInCompetition.entryId,
            ],
            set: {
              eventGroupRank: sql`excluded.event_group_rank`,
              eventPoints: sql`excluded.event_points`,
              eventCost: sql`excluded.event_cost`,
              eventNetPoints: sql`excluded.event_net_points`,
              eventRank: sql`excluded.event_rank`,
              cumulativeTransfers: sql`excluded.cumulative_transfers`,
              cumulativeCosts: sql`excluded.cumulative_costs`,
              cumulativeBenchPoints: sql`excluded.cumulative_bench_points`,
              cumulativeAutoSubPoints: sql`excluded.cumulative_auto_sub_points`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted tournament points group results', { count: results.length });
        return results.length;
      } catch (error) {
        logError('Failed to upsert tournament points group results', error, {
          count: results.length,
        });
        throw new DatabaseError(
          'Failed to upsert tournament points group results',
          'TOURNAMENT_POINTS_GROUP_RESULTS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentPointsGroupResultsRepository =
  createTournamentPointsGroupResultsRepository();
