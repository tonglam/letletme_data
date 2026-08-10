import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  tournamentGroupsInCompetition,
  type DbTournamentGroup,
  type DbTournamentGroupInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

const mapGroup = (row: typeof tournamentGroupsInCompetition.$inferSelect): DbTournamentGroup => ({
  ...row,
  id: row.sourceGroupRowId,
});

export const createTournamentGroupRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByTournamentAndEntries: async (
      season: FplSeasonRef,
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
            .from(tournamentGroupsInCompetition)
            .where(
              and(
                eq(tournamentGroupsInCompetition.seasonId, season.seasonId),
                eq(tournamentGroupsInCompetition.tournamentId, tournamentId),
                inArray(tournamentGroupsInCompetition.entryId, chunk),
              ),
            );
          results.push(...rows.map(mapGroup));
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
      season: FplSeasonRef,
      tournamentId: number,
      groupId: number | string,
    ): Promise<DbTournamentGroup[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentGroupsInCompetition)
          .where(
            and(
              eq(tournamentGroupsInCompetition.seasonId, season.seasonId),
              eq(tournamentGroupsInCompetition.tournamentId, tournamentId),
              eq(tournamentGroupsInCompetition.groupId, Number(groupId)),
            ),
          );
        logInfo('Retrieved tournament group entries', {
          tournamentId,
          groupId,
          count: rows.length,
        });
        return rows.map(mapGroup);
      } catch (error) {
        logError('Failed to retrieve tournament group entries', error, { tournamentId, groupId });
        throw new DatabaseError(
          'Failed to retrieve tournament group entries',
          'TOURNAMENT_GROUPS_FIND_BY_GROUP_ERROR',
          error as Error,
        );
      }
    },

    deleteByTournament: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .delete(tournamentGroupsInCompetition)
          .where(
            and(
              eq(tournamentGroupsInCompetition.seasonId, season.seasonId),
              eq(tournamentGroupsInCompetition.tournamentId, tournamentId),
            ),
          );
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
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<Array<{ groupId: number; groupIndex: number }>> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            groupId: tournamentGroupsInCompetition.groupId,
            groupIndex: tournamentGroupsInCompetition.groupIndex,
          })
          .from(tournamentGroupsInCompetition)
          .where(
            and(
              eq(tournamentGroupsInCompetition.seasonId, season.seasonId),
              eq(tournamentGroupsInCompetition.tournamentId, tournamentId),
            ),
          )
          .orderBy(tournamentGroupsInCompetition.groupId, tournamentGroupsInCompetition.groupIndex);
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

    upsertBatch: async (
      season: FplSeasonRef,
      groups: DbTournamentGroupInsert[],
    ): Promise<number> => {
      if (groups.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(tournamentGroupsInCompetition)
          .values(groups.map((group) => ({ ...group, seasonId: season.seasonId })))
          .onConflictDoUpdate({
            target: [
              tournamentGroupsInCompetition.tournamentId,
              tournamentGroupsInCompetition.groupId,
              tournamentGroupsInCompetition.entryId,
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
