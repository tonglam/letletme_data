import { and, eq, gte, isNotNull, lte, max, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentBattleGroupResults,
  type DbTournamentBattleGroupResult,
  type DbTournamentBattleGroupResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentBattleGroupResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByTournamentAndEvent: async (
      tournamentId: number,
      eventId: number,
    ): Promise<DbTournamentBattleGroupResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentBattleGroupResults)
          .where(
            and(
              eq(tournamentBattleGroupResults.tournamentId, tournamentId),
              eq(tournamentBattleGroupResults.eventId, eventId),
            ),
          );
        logInfo('Retrieved tournament battle group results', {
          tournamentId,
          eventId,
          count: rows.length,
        });
        return rows;
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
      tournamentId: number,
      startEventId: number,
      endEventId: number,
    ): Promise<DbTournamentBattleGroupResult[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentBattleGroupResults)
          .where(
            and(
              eq(tournamentBattleGroupResults.tournamentId, tournamentId),
              gte(tournamentBattleGroupResults.eventId, startEventId),
              lte(tournamentBattleGroupResults.eventId, endEventId),
            ),
          );
        logInfo('Retrieved tournament battle group results for event range', {
          tournamentId,
          startEventId,
          endEventId,
          count: rows.length,
        });
        return rows;
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
      tournamentId: number,
      startEventId: number,
      endEventId: number,
    ): Promise<number | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ maxEventId: max(tournamentBattleGroupResults.eventId) })
          .from(tournamentBattleGroupResults)
          .where(
            and(
              eq(tournamentBattleGroupResults.tournamentId, tournamentId),
              gte(tournamentBattleGroupResults.eventId, startEventId),
              lte(tournamentBattleGroupResults.eventId, endEventId),
              isNotNull(tournamentBattleGroupResults.homeMatchPoints),
              isNotNull(tournamentBattleGroupResults.awayMatchPoints),
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

    deleteByTournament: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentBattleGroupResults)
          .where(eq(tournamentBattleGroupResults.tournamentId, tournamentId));
      } catch (error) {
        logError('Failed to delete tournament battle group results', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament battle group results',
          'TOURNAMENT_BATTLE_RESULTS_DELETE_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (results: DbTournamentBattleGroupResultInsert[]): Promise<number> => {
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
          return rest;
        });
        await db
          .insert(tournamentBattleGroupResults)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              tournamentBattleGroupResults.tournamentId,
              tournamentBattleGroupResults.groupId,
              tournamentBattleGroupResults.eventId,
              tournamentBattleGroupResults.homeIndex,
              tournamentBattleGroupResults.awayIndex,
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
