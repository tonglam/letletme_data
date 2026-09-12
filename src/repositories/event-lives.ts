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

export type EventLiveCheckpointBinding = Readonly<{
  publicationId: string;
  generation: number;
  eventLiveSha256: string;
  /** Rebind rows when the terminal FINALIZED publication has the same payload. */
  forceIdentity?: boolean;
}>;

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
      options: { checkpoint?: EventLiveCheckpointBinding } = {},
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
          publicationId: options.checkpoint?.publicationId ?? null,
          publicationGeneration: options.checkpoint?.generation ?? null,
          publicationEventLiveSha256: options.checkpoint?.eventLiveSha256 ?? null,
        }));

        const db = await getDbInstance();
        // Live polling frequently returns the same player values.  The payload
        // hash is stable across identical publications, so a new non-terminal
        // checkpoint does not rewrite every row.  A terminal checkpoint may
        // force the exact FINALIZED publication identity onto the rows even
        // when its payload is unchanged.
        const payloadChanged = sql`
          ROW(
            ${playerGameweekStatsInFpl.minutes},
            ${playerGameweekStatsInFpl.goalsScored},
            ${playerGameweekStatsInFpl.assists},
            ${playerGameweekStatsInFpl.cleanSheets},
            ${playerGameweekStatsInFpl.goalsConceded},
            ${playerGameweekStatsInFpl.ownGoals},
            ${playerGameweekStatsInFpl.penaltiesSaved},
            ${playerGameweekStatsInFpl.penaltiesMissed},
            ${playerGameweekStatsInFpl.yellowCards},
            ${playerGameweekStatsInFpl.redCards},
            ${playerGameweekStatsInFpl.saves},
            ${playerGameweekStatsInFpl.bonus},
            ${playerGameweekStatsInFpl.bps},
            ${playerGameweekStatsInFpl.defensiveContribution},
            ${playerGameweekStatsInFpl.starts},
            ${playerGameweekStatsInFpl.expectedGoals},
            ${playerGameweekStatsInFpl.expectedAssists},
            ${playerGameweekStatsInFpl.expectedGoalInvolvements},
            ${playerGameweekStatsInFpl.expectedGoalsConceded},
            ${playerGameweekStatsInFpl.inDreamTeam},
            ${playerGameweekStatsInFpl.totalPoints},
            ${playerGameweekStatsInFpl.publicationEventLiveSha256}
          ) IS DISTINCT FROM ROW(
            excluded.minutes,
            excluded.goals_scored,
            excluded.assists,
            excluded.clean_sheets,
            excluded.goals_conceded,
            excluded.own_goals,
            excluded.penalties_saved,
            excluded.penalties_missed,
            excluded.yellow_cards,
            excluded.red_cards,
            excluded.saves,
            excluded.bonus,
            excluded.bps,
            excluded.defensive_contribution,
            excluded.starts,
            excluded.expected_goals,
            excluded.expected_assists,
            excluded.expected_goal_involvements,
            excluded.expected_goals_conceded,
            excluded.in_dream_team,
            excluded.total_points,
            excluded.publication_event_live_sha256
          )
          OR (${options.checkpoint?.forceIdentity === true ? sql`TRUE` : sql`FALSE`}
            AND ROW(
              ${playerGameweekStatsInFpl.publicationId},
              ${playerGameweekStatsInFpl.publicationGeneration}
            ) IS DISTINCT FROM ROW(excluded.publication_id, excluded.publication_generation))
        `;
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
              publicationId: sql`excluded.publication_id`,
              publicationGeneration: sql`excluded.publication_generation`,
              publicationEventLiveSha256: sql`excluded.publication_event_live_sha256`,
              updatedAt: sql`NOW()`,
            },
            where: payloadChanged,
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
