import { sql } from 'drizzle-orm';

import { playerStats, type DbPlayerStatInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PlayerStat } from '../domain/player-stats';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createPlayerStatsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertBatch: async (playerStatsList: PlayerStat[]): Promise<{ count: number }> => {
      try {
        if (playerStatsList.length === 0) {
          return { count: 0 };
        }

        const rows: DbPlayerStatInsert[] = playerStatsList.map((playerStat) => ({
          eventId: playerStat.eventId,
          elementId: playerStat.elementId,
          elementType: playerStat.elementType,
          totalPoints: playerStat.totalPoints,
          form: playerStat.form ?? null,
          influence: playerStat.influence ?? null,
          creativity: playerStat.creativity ?? null,
          threat: playerStat.threat ?? null,
          ictIndex: playerStat.ictIndex ?? null,
          expectedGoals: playerStat.expectedGoals ?? null,
          expectedAssists: playerStat.expectedAssists ?? null,
          expectedGoalInvolvements: playerStat.expectedGoalInvolvements ?? null,
          expectedGoalsConceded: playerStat.expectedGoalsConceded ?? null,
          minutes: playerStat.minutes ?? null,
          goalsScored: playerStat.goalsScored ?? null,
          assists: playerStat.assists ?? null,
          cleanSheets: playerStat.cleanSheets ?? null,
          goalsConceded: playerStat.goalsConceded ?? null,
          ownGoals: playerStat.ownGoals ?? null,
          penaltiesSaved: playerStat.penaltiesSaved ?? null,
          yellowCards: playerStat.yellowCards ?? null,
          redCards: playerStat.redCards ?? null,
          saves: playerStat.saves ?? null,
          bonus: playerStat.bonus ?? null,
          bps: playerStat.bps ?? null,
          starts: playerStat.starts ?? null,
          influenceRank: playerStat.influenceRank ?? null,
          influenceRankType: playerStat.influenceRankType ?? null,
          creativityRank: playerStat.creativityRank ?? null,
          creativityRankType: playerStat.creativityRankType ?? null,
          threatRank: playerStat.threatRank ?? null,
          threatRankType: playerStat.threatRankType ?? null,
          ictIndexRank: playerStat.ictIndexRank ?? null,
          ictIndexRankType: playerStat.ictIndexRankType ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        const db = await getDbInstance();
        const result = await db
          .insert(playerStats)
          .values(rows)
          .onConflictDoUpdate({
            target: [playerStats.eventId, playerStats.elementId],
            set: {
              totalPoints: sql`excluded.total_points`,
              form: sql`excluded.form`,
              influence: sql`excluded.influence`,
              creativity: sql`excluded.creativity`,
              threat: sql`excluded.threat`,
              ictIndex: sql`excluded.ict_index`,
              expectedGoals: sql`excluded.expected_goals`,
              expectedAssists: sql`excluded.expected_assists`,
              expectedGoalInvolvements: sql`excluded.expected_goal_involvements`,
              expectedGoalsConceded: sql`excluded.expected_goals_conceded`,
              minutes: sql`excluded.minutes`,
              goalsScored: sql`excluded.goals_scored`,
              assists: sql`excluded.assists`,
              cleanSheets: sql`excluded.clean_sheets`,
              goalsConceded: sql`excluded.goals_conceded`,
              ownGoals: sql`excluded.own_goals`,
              penaltiesSaved: sql`excluded.penalties_saved`,
              yellowCards: sql`excluded.yellow_cards`,
              redCards: sql`excluded.red_cards`,
              saves: sql`excluded.saves`,
              bonus: sql`excluded.bonus`,
              bps: sql`excluded.bps`,
              starts: sql`excluded.starts`,
              influenceRank: sql`excluded.influence_rank`,
              influenceRankType: sql`excluded.influence_rank_type`,
              creativityRank: sql`excluded.creativity_rank`,
              creativityRankType: sql`excluded.creativity_rank_type`,
              threatRank: sql`excluded.threat_rank`,
              threatRankType: sql`excluded.threat_rank_type`,
              ictIndexRank: sql`excluded.ict_index_rank`,
              ictIndexRankType: sql`excluded.ict_index_rank_type`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        logInfo('Batch upserted player stats', { count: result.length });
        return { count: result.length };
      } catch (error) {
        logError('Failed to batch upsert player stats', error, { count: playerStatsList.length });
        throw new DatabaseError(
          'Failed to batch upsert player stats',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const playerStatsRepository = createPlayerStatsRepository();
