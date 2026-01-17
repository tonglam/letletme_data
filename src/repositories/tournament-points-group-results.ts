import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentPointsGroupResults,
  type DbTournamentPointsGroupResult,
  type DbTournamentPointsGroupResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentPointsGroupResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByTournamentAndEvent: async (
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
            .from(tournamentPointsGroupResults)
            .where(
              and(
                eq(tournamentPointsGroupResults.tournamentId, tournamentId),
                eq(tournamentPointsGroupResults.eventId, eventId),
                inArray(tournamentPointsGroupResults.entryId, chunk),
              ),
            );
          results.push(...rows);
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

    upsertBatch: async (results: DbTournamentPointsGroupResultInsert[]): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentPointsGroupResults)
          .values(results)
          .onConflictDoUpdate({
            target: [
              tournamentPointsGroupResults.tournamentId,
              tournamentPointsGroupResults.groupId,
              tournamentPointsGroupResults.eventId,
              tournamentPointsGroupResults.entryId,
            ],
            set: {
              eventGroupRank: sql`excluded.event_group_rank`,
              eventPoints: sql`excluded.event_points`,
              eventCost: sql`excluded.event_cost`,
              eventNetPoints: sql`excluded.event_net_points`,
              eventRank: sql`excluded.event_rank`,
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
