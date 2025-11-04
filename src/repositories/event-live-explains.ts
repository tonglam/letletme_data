import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  eventLiveExplains,
  type DbEventLiveExplain,
  type DbEventLiveExplainInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { EventLiveExplainRecord } from '../transformers/event-live-explains';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EventLiveExplainsRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findByEventId(eventId: number): Promise<DbEventLiveExplain[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, eventId));
      logInfo('Retrieved event live explains by event ID', { eventId, count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find event live explains by event ID', error, { eventId });
      throw new DatabaseError(
        `Failed to retrieve event live explains for event: ${eventId}`,
        'FIND_EXPLAINS_BY_EVENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findByEventAndElement(eventId: number, elementId: number): Promise<DbEventLiveExplain | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db
        .select()
        .from(eventLiveExplains)
        .where(and(eq(eventLiveExplains.eventId, eventId), eq(eventLiveExplains.elementId, elementId)));
      return result[0] || null;
    } catch (error) {
      logError('Failed to find event live explains by event and element', error, {
        eventId,
        elementId,
      });
      throw new DatabaseError(
        `Failed to retrieve event live explains for event ${eventId}, element ${elementId}`,
        'FIND_EXPLAINS_BY_EVENT_ELEMENT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(records: EventLiveExplainRecord[]): Promise<DbEventLiveExplain[]> {
    try {
      if (records.length === 0) return [];

      const inserts: DbEventLiveExplainInsert[] = records.map((r) => ({
        eventId: r.eventId,
        elementId: r.elementId,
        bonus: r.bonus,
        minutes: r.minutes,
        minutesPoints: r.minutesPoints,
        goalsScored: r.goalsScored,
        goalsScoredPoints: r.goalsScoredPoints,
        assists: r.assists,
        assistsPoints: r.assistsPoints,
        cleanSheets: r.cleanSheets,
        cleanSheetsPoints: r.cleanSheetsPoints,
        goalsConceded: r.goalsConceded,
        goalsConcededPoints: r.goalsConcededPoints,
        ownGoals: r.ownGoals,
        ownGoalsPoints: r.ownGoalsPoints,
        penaltiesSaved: r.penaltiesSaved,
        penaltiesSavedPoints: r.penaltiesSavedPoints,
        penaltiesMissed: r.penaltiesMissed,
        penaltiesMissedPoints: r.penaltiesMissedPoints,
        yellowCards: r.yellowCards,
        yellowCardsPoints: r.yellowCardsPoints,
        redCards: r.redCards,
        redCardsPoints: r.redCardsPoints,
        saves: r.saves,
        savesPoints: r.savesPoints,
        mngWinPoints: r.mngWinPoints,
        mngDrawPoints: r.mngDrawPoints,
        mngLossPoints: r.mngLossPoints,
        mngUnderdogWinPoints: r.mngUnderdogWinPoints,
        mngUnderdogDrawPoints: r.mngUnderdogDrawPoints,
        mngCleanSheetsPoints: r.mngCleanSheetsPoints,
        mngGoalsScoredPoints: r.mngGoalsScoredPoints,
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(eventLiveExplains)
        .values(inserts)
        .onConflictDoUpdate({
          target: [eventLiveExplains.elementId, eventLiveExplains.eventId],
          set: {
            bonus: sql`excluded.bonus`,
            minutes: sql`excluded.minutes`,
            minutesPoints: sql`excluded.minutes_points`,
            goalsScored: sql`excluded.goals_scored`,
            goalsScoredPoints: sql`excluded.goals_scored_points`,
            assists: sql`excluded.assists`,
            assistsPoints: sql`excluded.assists_points`,
            cleanSheets: sql`excluded.clean_sheets`,
            cleanSheetsPoints: sql`excluded.clean_sheets_points`,
            goalsConceded: sql`excluded.goals_conceded`,
            goalsConcededPoints: sql`excluded.goals_conceded_points`,
            ownGoals: sql`excluded.own_goals`,
            ownGoalsPoints: sql`excluded.own_goals_points`,
            penaltiesSaved: sql`excluded.penalties_saved`,
            penaltiesSavedPoints: sql`excluded.penalties_saved_points`,
            penaltiesMissed: sql`excluded.penalties_missed`,
            penaltiesMissedPoints: sql`excluded.penalties_missed_points`,
            yellowCards: sql`excluded.yellow_cards`,
            yellowCardsPoints: sql`excluded.yellow_cards_points`,
            redCards: sql`excluded.red_cards`,
            redCardsPoints: sql`excluded.red_cards_points`,
            saves: sql`excluded.saves`,
            savesPoints: sql`excluded.saves_points`,
            mngWinPoints: sql`excluded.mng_win_points`,
            mngDrawPoints: sql`excluded.mng_draw_points`,
            mngLossPoints: sql`excluded.mng_loss_points`,
            mngUnderdogWinPoints: sql`excluded.mng_underdog_win_points`,
            mngUnderdogDrawPoints: sql`excluded.mng_underdog_draw_points`,
            mngCleanSheetsPoints: sql`excluded.mng_clean_sheets_points`,
            mngGoalsScoredPoints: sql`excluded.mng_goals_scored_points`,
          },
        })
        .returning();

      logInfo('Batch upserted event live explains', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to batch upsert event live explains', error, { count: records.length });
      throw new DatabaseError(
        'Failed to batch upsert event live explains',
        'BATCH_EXPLAINS_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

export const eventLiveExplainsRepository = new EventLiveExplainsRepository();
