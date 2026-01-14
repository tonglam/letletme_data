import { and, eq, sql } from 'drizzle-orm';
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

export class TournamentBattleGroupResultsRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findByTournamentAndEvent(
    tournamentId: number,
    eventId: number,
  ): Promise<DbTournamentBattleGroupResult[]> {
    try {
      const db = await this.getDbInstance();
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
  }

  async upsertBatch(results: DbTournamentBattleGroupResultInsert[]): Promise<number> {
    if (results.length === 0) {
      return 0;
    }

    try {
      const db = await this.getDbInstance();
      await db
        .insert(tournamentBattleGroupResults)
        .values(results)
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
  }
}

export const tournamentBattleGroupResultsRepository = new TournamentBattleGroupResultsRepository();
