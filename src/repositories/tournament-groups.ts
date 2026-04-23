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
              eq(tournamentGroups.groupId, Number(groupId)),
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

    deleteByTournament: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db.delete(tournamentGroups).where(eq(tournamentGroups.tournamentId, tournamentId));
      } catch (error) {
        logError('Failed to delete tournament groups', error, { tournamentId });
        throw new DatabaseError(
          'Failed to delete tournament groups',
          'TOURNAMENT_GROUPS_DELETE_ERROR',
          error as Error,
        );
      }
    },

    findGroupSlots: async (
      tournamentId: number,
    ): Promise<Array<{ groupId: number; groupIndex: number }>> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            groupId: tournamentGroups.groupId,
            groupIndex: tournamentGroups.groupIndex,
          })
          .from(tournamentGroups)
          .where(eq(tournamentGroups.tournamentId, tournamentId))
          .orderBy(tournamentGroups.groupId, tournamentGroups.groupIndex);
        return rows;
      } catch (error) {
        logError('Failed to find tournament group slots', error, { tournamentId });
        throw new DatabaseError(
          'Failed to find tournament group slots',
          'TOURNAMENT_GROUPS_SLOTS_ERROR',
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
            target: [
              tournamentGroups.tournamentId,
              tournamentGroups.groupId,
              tournamentGroups.entryId,
            ],
            set: {
              groupName: sql`excluded.group_name`,
              groupIndex: sql`excluded.group_index`,
              startedEventId: sql`excluded.started_event_id`,
              endedEventId: sql`excluded.ended_event_id`,
              groupPoints: sql`excluded.group_points`,
              groupRank: sql`excluded.group_rank`,
              played: sql`excluded.played`,
              won: sql`excluded.won`,
              drawn: sql`excluded.drawn`,
              lost: sql`excluded.lost`,
              totalPoints: sql`excluded.total_points`,
              totalTransfersCost: sql`excluded.total_transfers_cost`,
              totalNetPoints: sql`excluded.total_net_points`,
              qualified: sql`excluded.qualified`,
              overallRank: sql`excluded.overall_rank`,
              createdAt: sql`excluded.created_at`,
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
