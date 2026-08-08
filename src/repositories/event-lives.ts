import { and, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm';

import {
  playerGameweekStatsInFpl,
  type DbEventLive,
  type DbEventLiveInsert,
} from '../db/schemas/index.schema';
import { eventsInFpl } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export type EventLiveRepository = ReturnType<typeof createEventLiveRepository>;

/**
 * EventLiveRepository - Data Access Layer
 *
 * Handles all database operations for event live data:
 * - Query by event
 * - Single and batch upserts
 * - Optimized for bulk sync operations
 */
export const createEventLiveRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    /**
     * Find all event live records for a specific event
     */
    findByEventId: async (season: FplSeasonRef, eventId: number): Promise<DbEventLive[]> => {
      try {
        const db = await getDbInstance();
        const result = await db
          .select()
          .from(playerGameweekStatsInFpl)
          .where(
            and(
              eq(playerGameweekStatsInFpl.seasonId, season.seasonId),
              eq(playerGameweekStatsInFpl.eventId, eventId),
            ),
          );

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
     * Return only rows whose source write belongs to a finalized event in the
     * requested season. Event IDs repeat annually, so row presence alone is
     * not sufficient evidence for post-event tournament calculations.
     */
    findFinalizedByEventId: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<DbEventLive[]> => {
      try {
        const db = await getDbInstance();
        const result = await db
          .select(getTableColumns(playerGameweekStatsInFpl))
          .from(playerGameweekStatsInFpl)
          .innerJoin(
            eventsInFpl,
            and(
              eq(eventsInFpl.seasonId, playerGameweekStatsInFpl.seasonId),
              eq(eventsInFpl.eventId, playerGameweekStatsInFpl.eventId),
            ),
          )
          .where(
            and(
              eq(playerGameweekStatsInFpl.seasonId, season.seasonId),
              eq(playerGameweekStatsInFpl.eventId, eventId),
              eq(eventsInFpl.finished, true),
              eq(eventsInFpl.dataChecked, true),
              isNotNull(eventsInFpl.deadlineTime),
              // A finalized event flag alone does not prove that the rows
              // came from the final durable live consolidation. The explicit
              // marker is written in that same transaction, after the full
              // event-live payload is persisted; require every accepted row
              // to be newer than that marker.
              isNotNull(eventsInFpl.liveSnapshotFinalizedAt),
              sql`coalesce(${playerGameweekStatsInFpl.updatedAt}, ${playerGameweekStatsInFpl.createdAt}) >= ${eventsInFpl.liveSnapshotFinalizedAt}`,
              sql`coalesce(${playerGameweekStatsInFpl.updatedAt}, ${playerGameweekStatsInFpl.createdAt}) >= ${eventsInFpl.deadlineTime}`,
            ),
          );

        logInfo('Retrieved season-owned finalized event live data', {
          eventId,
          season: season.seasonCode,
          count: result.length,
        });
        return result;
      } catch (error) {
        logError('Failed to find season-owned finalized event live data', error, {
          eventId,
          season: season.seasonCode,
        });
        throw new DatabaseError(
          `Failed to retrieve finalized event live data for event: ${eventId}`,
          'FIND_FINALIZED_EVENT_LIVE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Batch upsert event live records
     */
    upsertBatch: async (
      season: FplSeasonRef,
      eventLiveData: EventLive[],
    ): Promise<DbEventLive[]> => {
      try {
        if (eventLiveData.length === 0) {
          return [];
        }

        const newRecords: DbEventLiveInsert[] = eventLiveData.map((data) => ({
          seasonId: season.seasonId,
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
          defensiveContribution: data.defensiveContribution ?? 0,
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
          .insert(playerGameweekStatsInFpl)
          .values(newRecords)
          .onConflictDoUpdate({
            target: [
              playerGameweekStatsInFpl.seasonId,
              playerGameweekStatsInFpl.eventId,
              playerGameweekStatsInFpl.elementId,
            ],
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
              defensiveContribution: sql`excluded.defensive_contribution`,
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
