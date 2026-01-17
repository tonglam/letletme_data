import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  tournamentGroups,
  type DbTournamentGroup,
  type DbTournamentGroupInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTournamentGroupRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findByTournamentAndEntries: async (
      tournamentId: number,
      entryIds: number[],
    ): Promise<DbTournamentGroup[]> => {
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

        const results: DbTournamentGroup[] = [];
        for (const chunk of chunks) {
          const rows = await db
            .select()
            .from(tournamentGroups)
            .where(
              and(
                eq(tournamentGroups.tournamentId, tournamentId),
                inArray(tournamentGroups.entryId, chunk),
              ),
            );
          results.push(...rows);
        }

        logInfo('Retrieved tournament groups', { tournamentId, count: results.length });
        return results;
      } catch (error) {
        logError('Failed to retrieve tournament groups', error, { tournamentId });
        throw new DatabaseError(
          'Failed to retrieve tournament groups',
          'TOURNAMENT_GROUPS_FIND_ERROR',
          error as Error,
        );
      }
    },

    findByTournamentAndGroup: async (
      tournamentId: number,
      groupId: string,
    ): Promise<DbTournamentGroup[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentGroups)
          .where(
            and(
              eq(tournamentGroups.tournamentId, tournamentId),
              eq(tournamentGroups.groupId, groupId),
            ),
          );
        logInfo('Retrieved tournament group entries', {
          tournamentId,
          groupId,
          count: rows.length,
        });
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament group entries', error, { tournamentId, groupId });
        throw new DatabaseError(
          'Failed to retrieve tournament group entries',
          'TOURNAMENT_GROUPS_FIND_BY_GROUP_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (groups: DbTournamentGroupInsert[]): Promise<number> => {
      if (groups.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentGroups)
          .values(groups)
          .onConflictDoUpdate({
            target: [tournamentGroups.tournamentId, tournamentGroups.entryId],
            set: {
              groupId: sql`excluded.group_id`,
              groupRank: sql`excluded.group_rank`,
              groupPoints: sql`excluded.group_points`,
              groupWins: sql`excluded.group_wins`,
              groupLoses: sql`excluded.group_loses`,
              groupDraws: sql`excluded.group_draws`,
              state: sql`excluded.state`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted tournament groups', { count: groups.length });
        return groups.length;
      } catch (error) {
        logError('Failed to upsert tournament groups', error, { count: groups.length });
        throw new DatabaseError(
          'Failed to upsert tournament groups',
          'TOURNAMENT_GROUPS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentGroupRepository = createTournamentGroupRepository();
