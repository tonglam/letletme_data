import { and, eq, sql } from 'drizzle-orm';
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

/**
 * EventLiveRepository - Data Access Layer
 *
 * Handles all database operations for event live data:
 * - CRUD operations
 * - Batch upserts
 * - Query by event or player
 */
export class EventLiveRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  /**
   * Find all event live records for a specific event
   */
  async findByEventId(eventId: number): Promise<DbEventLive[]> {
    try {
      const db = await this.getDbInstance();
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
  }

  /**
   * Find event live record for a specific player in a specific event
   */
  async findByEventAndElement(eventId: number, elementId: number): Promise<DbEventLive | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(eventLive)
        .where(and(eq(eventLive.eventId, eventId), eq(eventLive.elementId, elementId)));

      const record = result[0] || null;

      if (record) {
        logInfo('Retrieved event live data by event and element', { eventId, elementId });
      } else {
        logInfo('Event live data not found', { eventId, elementId });
      }

      return record;
    } catch (error) {
      logError('Failed to find event live data by event and element', error, {
        eventId,
        elementId,
      });
      throw new DatabaseError(
        `Failed to retrieve event live data for event ${eventId}, element ${elementId}`,
        'FIND_BY_EVENT_ELEMENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Find all event live records for a specific player across all events
   */
  async findByElementId(elementId: number): Promise<DbEventLive[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(eventLive).where(eq(eventLive.elementId, elementId));

      logInfo('Retrieved event live data by element ID', { elementId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find event live data by element ID', error, { elementId });
      throw new DatabaseError(
        `Failed to retrieve event live data for element: ${elementId}`,
        'FIND_BY_ELEMENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Upsert a single event live record
   */
  async upsert(eventLiveData: EventLive): Promise<DbEventLive> {
    try {
      const newRecord: DbEventLiveInsert = {
        eventId: eventLiveData.eventId,
        elementId: eventLiveData.elementId,
        minutes: eventLiveData.minutes,
        goalsScored: eventLiveData.goalsScored,
        assists: eventLiveData.assists,
        cleanSheets: eventLiveData.cleanSheets,
        goalsConceded: eventLiveData.goalsConceded,
        ownGoals: eventLiveData.ownGoals,
        penaltiesSaved: eventLiveData.penaltiesSaved,
        penaltiesMissed: eventLiveData.penaltiesMissed,
        yellowCards: eventLiveData.yellowCards,
        redCards: eventLiveData.redCards,
        saves: eventLiveData.saves,
        bonus: eventLiveData.bonus,
        bps: eventLiveData.bps,
        starts: eventLiveData.starts,
        expectedGoals: eventLiveData.expectedGoals,
        expectedAssists: eventLiveData.expectedAssists,
        expectedGoalInvolvements: eventLiveData.expectedGoalInvolvements,
        expectedGoalsConceded: eventLiveData.expectedGoalsConceded,
        inDreamTeam: eventLiveData.inDreamTeam,
        totalPoints: eventLiveData.totalPoints,
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(eventLive)
        .values(newRecord)
        .onConflictDoUpdate({
          target: [eventLive.eventId, eventLive.elementId],
          set: newRecord,
        })
        .returning();

      const upsertedRecord = result[0];
      logInfo('Upserted event live record', {
        eventId: upsertedRecord.eventId,
        elementId: upsertedRecord.elementId,
      });

      return upsertedRecord;
    } catch (error) {
      logError('Failed to upsert event live record', error, {
        eventId: eventLiveData.eventId,
        elementId: eventLiveData.elementId,
      });
      throw new DatabaseError(
        `Failed to upsert event live data for event ${eventLiveData.eventId}, element ${eventLiveData.elementId}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Batch upsert event live records
   */
  async upsertBatch(eventLiveData: EventLive[]): Promise<DbEventLive[]> {
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

      const db = await this.getDbInstance();
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
  }

  /**
   * Delete all event live records for a specific event
   */
  async deleteByEventId(eventId: number): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(eventLive).where(eq(eventLive.eventId, eventId));

      logInfo('Deleted event live records by event ID', { eventId });
    } catch (error) {
      logError('Failed to delete event live records by event ID', error, { eventId });
      throw new DatabaseError(
        `Failed to delete event live data for event: ${eventId}`,
        'DELETE_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const eventLiveRepository = new EventLiveRepository();
