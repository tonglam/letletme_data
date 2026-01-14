import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RowList } from 'postgres';

import {
  eventLiveSummaries,
  type DbEventLiveSummaryInsert,
} from '../db/schemas/event-live-summaries.schema';
import { getDb } from '../db/singleton';
import type { EventLiveSummary } from '../domain/event-live-summaries';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export type EventLiveSummaryAggregateRow = {
  elementId: number;
  elementType: number;
  teamId: number;
  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;
  totalPoints: number;
};

export class EventLiveSummariesRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private mapRowList<T>(result: RowList<Record<string, unknown>>): T[] {
    return [...result] as T[];
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async aggregateSummaries(): Promise<EventLiveSummaryAggregateRow[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.execute(sql`
        SELECT
          el.element_id as "elementId",
          p.type as "elementType",
          p.team_id as "teamId",
          COALESCE(SUM(el.minutes), 0)::int as "minutes",
          COALESCE(SUM(el.goals_scored), 0)::int as "goalsScored",
          COALESCE(SUM(el.assists), 0)::int as "assists",
          COALESCE(SUM(el.clean_sheets), 0)::int as "cleanSheets",
          COALESCE(SUM(el.goals_conceded), 0)::int as "goalsConceded",
          COALESCE(SUM(el.own_goals), 0)::int as "ownGoals",
          COALESCE(SUM(el.penalties_saved), 0)::int as "penaltiesSaved",
          COALESCE(SUM(el.penalties_missed), 0)::int as "penaltiesMissed",
          COALESCE(SUM(el.yellow_cards), 0)::int as "yellowCards",
          COALESCE(SUM(el.red_cards), 0)::int as "redCards",
          COALESCE(SUM(el.saves), 0)::int as "saves",
          COALESCE(SUM(el.bonus), 0)::int as "bonus",
          COALESCE(SUM(el.bps), 0)::int as "bps",
          COALESCE(SUM(el.total_points), 0)::int as "totalPoints"
        FROM event_lives el
        INNER JOIN players p ON p.id = el.element_id
        GROUP BY el.element_id, p.type, p.team_id
        ORDER BY el.element_id
      `);

      const rows = this.mapRowList<EventLiveSummaryAggregateRow>(result);
      logInfo('Aggregated event live summaries', { count: rows.length });
      return rows;
    } catch (error) {
      logError('Failed to aggregate event live summaries', error);
      throw new DatabaseError(
        'Failed to aggregate event live summaries',
        'AGGREGATE_SUMMARY_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async replaceAll(summaries: EventLiveSummary[]): Promise<{ count: number }> {
    try {
      const db = await this.getDbInstance();

      await db.execute(sql`TRUNCATE TABLE event_live_summaries`);

      if (summaries.length === 0) {
        logInfo('Event live summaries replaced with empty set');
        return { count: 0 };
      }

      const inserts: DbEventLiveSummaryInsert[] = summaries.map((summary) => ({
        eventId: summary.eventId,
        elementId: summary.elementId,
        elementType: summary.elementType,
        teamId: summary.teamId,
        minutes: summary.minutes,
        goalsScored: summary.goalsScored,
        assists: summary.assists,
        cleanSheets: summary.cleanSheets,
        goalsConceded: summary.goalsConceded,
        ownGoals: summary.ownGoals,
        penaltiesSaved: summary.penaltiesSaved,
        penaltiesMissed: summary.penaltiesMissed,
        yellowCards: summary.yellowCards,
        redCards: summary.redCards,
        saves: summary.saves,
        bonus: summary.bonus,
        bps: summary.bps,
        totalPoints: summary.totalPoints,
      }));

      const result = await db.insert(eventLiveSummaries).values(inserts).returning();
      logInfo('Replaced event live summaries', { count: result.length });
      return { count: result.length };
    } catch (error) {
      logError('Failed to replace event live summaries', error, { count: summaries.length });
      throw new DatabaseError(
        'Failed to replace event live summaries',
        'REPLACE_SUMMARY_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

export const eventLiveSummariesRepository = new EventLiveSummariesRepository();
