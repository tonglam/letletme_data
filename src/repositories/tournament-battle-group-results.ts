import { and, eq, gte, isNotNull, lte, max, sql } from 'drizzle-orm';
import {
  tournamentBattleGroupResultsInCompetition,
  type DbTournamentBattleGroupResult,
  type DbTournamentBattleGroupResultInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const mapResult = (
  row: typeof tournamentBattleGroupResultsInCompetition.$inferSelect,
): DbTournamentBattleGroupResult => ({ ...row, id: row.sourceResultId });

export const createTournamentBattleGroupResultsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByTournamentAndEvent: async (
      season: FplSeasonRef,
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentBattleGroupResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentBattleGroupResultsInCompetition)
          .where(
            and(
              eq(tournamentBattleGroupResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentBattleGroupResultsInCompetition.tournamentId, tournamentId),
              eq(tournamentBattleGroupResultsInCompetition.eventId, eventId),
            ),
          );
        logInfo('Retrieved tournament battle group results', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows.map(mapResult);
      } catch (error) {
        logError('Failed to retrieve tournament battle group results', error, {
          tournamentId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament battle group results',
          'TOURNAMENT_BATTLE_RESULTS_FIND_ERROR',
          error as Error,
        );
      }
    },

    findByTournamentAndEventRange: async (
      season: FplSeasonRef,
      tournamentId: number,
      startEventId: number,
      endEventId: number,
    ): Promise<DbTournamentBattleGroupResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentBattleGroupResultsInCompetition)
          .where(
            and(
              eq(tournamentBattleGroupResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentBattleGroupResultsInCompetition.tournamentId, tournamentId),
              gte(tournamentBattleGroupResultsInCompetition.eventId, startEventId),
              lte(tournamentBattleGroupResultsInCompetition.eventId, endEventId),
            ),
          );
        logInfo('Retrieved tournament battle group results for event range', {
          tournamentId,
          startEventId,
          endEventId,
          count: rows.length,
        });
        return rows.map(mapResult);
      } catch (error) {
        logError('Failed to retrieve tournament battle group results for event range', error, {
          tournamentId,
          startEventId,
          endEventId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament battle group results for event range',
          'TOURNAMENT_BATTLE_RESULTS_FIND_RANGE_ERROR',
          error as Error,
        );
      }
    },

    /**
     * Latest event_id with **scored** battle rows (non-null match points) in
     * [start, end]. Pre-created future fixtures (NULL points) must not extend
     * the recompute horizon — that would load missing entry results and skip
     * all group updates (FP-09 Codex P1).
     */
    findMaxEventIdInRange: async (
      season: FplSeasonRef,
      tournamentId: number,
      startEventId: number,
      endEventId: number,
    ): Promise<number | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ maxEventId: max(tournamentBattleGroupResultsInCompetition.eventId) })
          .from(tournamentBattleGroupResultsInCompetition)
          .where(
            and(
              eq(tournamentBattleGroupResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentBattleGroupResultsInCompetition.tournamentId, tournamentId),
              gte(tournamentBattleGroupResultsInCompetition.eventId, startEventId),
              lte(tournamentBattleGroupResultsInCompetition.eventId, endEventId),
              isNotNull(tournamentBattleGroupResultsInCompetition.homeMatchPoints),
              isNotNull(tournamentBattleGroupResultsInCompetition.awayMatchPoints),
            ),
          );
        const value = rows[0]?.maxEventId;
        return typeof value === 'number' ? value : value != null ? Number(value) : null;
      } catch (error) {
        logError('Failed to find max battle group result event id', error, {
          tournamentId,
          startEventId,
          endEventId,
        });
        throw new DatabaseError(
          'Failed to find max battle group result event id',
          'TOURNAMENT_BATTLE_RESULTS_MAX_EVENT_ERROR',
          error as Error,
        );
      }
    },

    deleteByTournament: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentBattleGroupResultsInCompetition)
          .where(
            and(
              eq(tournamentBattleGroupResultsInCompetition.seasonId, season.seasonId),
              eq(tournamentBattleGroupResultsInCompetition.tournamentId, tournamentId),
            ),
          );
      } catch (error) {
        logError('Failed to delete tournament battle group results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament battle group results',
          'TOURNAMENT_BATTLE_RESULTS_DELETE_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      results: DbTournamentBattleGroupResultInsert[],
    ): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        // Drop identity `id` when re-upserting rows loaded from a prior SELECT;
        // GENERATED ALWAYS (and some drivers) reject explicit id values.
        const rows = results.map((row) => {
          const { id: _omitId, ...rest } = row as DbTournamentBattleGroupResultInsert & {
            id?: number;
          };
          return { ...rest, seasonId: season.seasonId };
        });
        await db
          .insert(tournamentBattleGroupResultsInCompetition)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              tournamentBattleGroupResultsInCompetition.tournamentId,
              tournamentBattleGroupResultsInCompetition.groupId,
              tournamentBattleGroupResultsInCompetition.eventId,
              tournamentBattleGroupResultsInCompetition.homeIndex,
              tournamentBattleGroupResultsInCompetition.awayIndex,
            ],
            set: {
              homeNetPoints: sql`excluded.home_net_points`,
              homeRank: sql`excluded.home_rank`,
              homeMatchPoints: sql`excluded.home_match_points`,
              awayNetPoints: sql`excluded.away_net_points`,
              awayRank: sql`excluded.away_rank`,
              awayMatchPoints: sql`excluded.away_match_points`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted tournament battle group results', { count: results.length });
        return results.length;
      } catch (error) {
        logError('Failed to upsert tournament battle group results', error, {
          count: results.length,
        });
        throw new DatabaseError(
          'Failed to upsert tournament battle group results',
          'TOURNAMENT_BATTLE_RESULTS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentBattleGroupResultsRepository =
  createTournamentBattleGroupResultsRepository();
