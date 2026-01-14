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

export class TournamentGroupRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findByTournamentAndEntries(
    tournamentId: number,
    entryIds: number[],
  ): Promise<DbTournamentGroup[]> {
    if (entryIds.length === 0) {
      return [];
    }

    try {
      const db = await this.getDbInstance();
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
        'TOURNAMENT_GROUP_FIND_ERROR',
        error as Error,
      );
    }
  }

  async findByTournamentAndGroup(
    tournamentId: number,
    groupId: number,
  ): Promise<DbTournamentGroup[]> {
    try {
      const db = await this.getDbInstance();
      const rows = await db
        .select()
        .from(tournamentGroups)
        .where(
          and(
            eq(tournamentGroups.tournamentId, tournamentId),
            eq(tournamentGroups.groupId, groupId),
          ),
        )
        .orderBy(tournamentGroups.groupIndex);
      logInfo('Retrieved tournament group entries', {
        tournamentId,
        groupId,
        count: rows.length,
      });
      return rows;
    } catch (error) {
      logError('Failed to retrieve tournament group entries', error, {
        tournamentId,
        groupId,
      });
      throw new DatabaseError(
        'Failed to retrieve tournament group entries',
        'TOURNAMENT_GROUP_FIND_ERROR',
        error as Error,
      );
    }
  }

  async upsertBatch(groups: DbTournamentGroupInsert[]): Promise<number> {
    if (groups.length === 0) {
      return 0;
    }

    try {
      const db = await this.getDbInstance();
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
            groupPoints: sql`excluded.group_points`,
            groupRank: sql`excluded.group_rank`,
            played: sql`excluded.played`,
            totalPoints: sql`excluded.total_points`,
            totalTransfersCost: sql`excluded.total_transfers_cost`,
            totalNetPoints: sql`excluded.total_net_points`,
            overallRank: sql`excluded.overall_rank`,
          },
        });

      logInfo('Upserted tournament groups', { count: groups.length });
      return groups.length;
    } catch (error) {
      logError('Failed to upsert tournament groups', error, { count: groups.length });
      throw new DatabaseError(
        'Failed to upsert tournament groups',
        'TOURNAMENT_GROUP_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const tournamentGroupRepository = new TournamentGroupRepository();
