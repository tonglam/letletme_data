import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  eventLive,
  type DbEventLive,
  type DbEventLiveInsert,
} from '../db/schemas/event-lives.schema';
import { getDb } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export type EventLiveRepository = ReturnType<typeof createEventLiveRepository>;

/**
 * EventLiveRepository - Data Access Layer
 *
 * Handles all database operations for event live data:
 * - Query by event
 * - Single and batch upserts
 * - Optimized for bulk sync operations
 */
export const createEventLiveRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    /**
     * Find all event live records for a specific event
     */
    findByEventId: async (eventId: number): Promise<DbEventLive[]> => {
      try {
        const db = await getDbInstance();
        const result = await db.select().from(eventLive).where(eq(eventLive.eventId, eventId));

        logInfo('Retrieved event live data by event ID', { eventId, count: result.length });
        return result;
      } catch (error) {
        logError('Failed to find event live data by event ID', error, { eventId });
        throw new DatabaseError(
          `Failed to retrieve event live data for event: ${eventId}`,
          'FIND_BY_EVENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Batch upsert event live records
     */
    upsertBatch: async (eventLiveData: EventLive[]): Promise<DbEventLive[]> => {
      try {
        if (eventLiveData.length === 0) {
          return [];
        }

        const newRecords: DbEventLiveInsert[] = eventLiveData.map((data) => ({
          eventId: data.eventId,
          elementId: data.elementId,
          minutes: data.minutes,
          goalsScored: data.goalsScored,
          assists: data.assists,
          cleanSheets: data.cleanSheets,
          goalsConceded: data.goalsConceded,
          ownGoals: data.ownGoals,
          penaltiesSaved: data.penaltiesSaved,
          penaltiesMissed: data.penaltiesMissed,
          yellowCards: data.yellowCards,
          redCards: data.redCards,
          saves: data.saves,
          bonus: data.bonus,
          bps: data.bps,
          starts: data.starts,
          expectedGoals: data.expectedGoals,
          expectedAssists: data.expectedAssists,
          expectedGoalInvolvements: data.expectedGoalInvolvements,
          expectedGoalsConceded: data.expectedGoalsConceded,
          inDreamTeam: data.inDreamTeam,
          totalPoints: data.totalPoints,
        }));

        const db = await getDbInstance();
        const result = await db
          .insert(eventLive)
          .values(newRecords)
          .onConflictDoUpdate({
            target: [eventLive.eventId, eventLive.elementId],
            set: {
              minutes: sql`excluded.minutes`,
              goalsScored: sql`excluded.goals_scored`,
              assists: sql`excluded.assists`,
              cleanSheets: sql`excluded.clean_sheets`,
              goalsConceded: sql`excluded.goals_conceded`,
              ownGoals: sql`excluded.own_goals`,
              penaltiesSaved: sql`excluded.penalties_saved`,
              penaltiesMissed: sql`excluded.penalties_missed`,
              yellowCards: sql`excluded.yellow_cards`,
              redCards: sql`excluded.red_cards`,
              saves: sql`excluded.saves`,
              bonus: sql`excluded.bonus`,
              bps: sql`excluded.bps`,
              starts: sql`excluded.starts`,
              expectedGoals: sql`excluded.expected_goals`,
              expectedAssists: sql`excluded.expected_assists`,
              expectedGoalInvolvements: sql`excluded.expected_goal_involvements`,
              expectedGoalsConceded: sql`excluded.expected_goals_conceded`,
              inDreamTeam: sql`excluded.in_dream_team`,
              totalPoints: sql`excluded.total_points`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        logInfo('Batch upserted event live records', { count: result.length });
        return result;
      } catch (error) {
        logError('Failed to batch upsert event live records', error, {
          count: eventLiveData.length,
        });
        throw new DatabaseError(
          'Failed to batch upsert event live data',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const eventLiveRepository = createEventLiveRepository();
