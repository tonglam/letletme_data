import { and, asc, desc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';

import { eventsInFpl, type DbEvent } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { neighbourEventId } from '../domain/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Event as DomainEvent, EventChipData, EventTopElementData } from '../types';

function mapDbEventToDomain(event: DbEvent): DomainEvent {
  return {
    id: event.eventId,
    name: event.name,
    deadlineTime: event.deadlineTime,
    averageEntryScore: event.averageEntryScore,
    finished: event.finished,
    dataChecked: event.dataChecked,
    dataCheckedAt: event.dataCheckedAt,
    highestScoringEntry: event.highestScoringEntry,
    deadlineTimeEpoch: event.deadlineTimeEpoch,
    deadlineTimeGameOffset: event.deadlineTimeGameOffset,
    highestScore: event.highestScore,
    isPrevious: event.isPrevious,
    isCurrent: event.isCurrent,
    isNext: event.isNext,
    cupLeagueCreate: event.cupLeagueCreate,
    h2hKoMatchesCreated: event.h2HKoMatchesCreated,
    chipPlays: event.chipPlays as EventChipData[] | null,
    mostSelected: event.mostSelected,
    mostTransferredIn: event.mostTransferredIn,
    topElement: event.topElement,
    topElementInfo: event.topElementInfo as EventTopElementData | null,
    transfersMade: event.transfersMade,
    mostCaptained: event.mostCaptained,
    mostViceCaptained: event.mostViceCaptained,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export const createEventRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const findCurrentInternal = async (season: FplSeasonRef): Promise<DomainEvent | null> => {
    const db = await getDbInstance();
    const nowEpoch = Math.floor(Date.now() / 1000);
    const rows = await db
      .select()
      .from(eventsInFpl)
      .where(
        and(
          eq(eventsInFpl.seasonId, season.seasonId),
          isNotNull(eventsInFpl.deadlineTimeEpoch),
          lte(eventsInFpl.deadlineTimeEpoch, nowEpoch),
        ),
      )
      .orderBy(desc(eventsInFpl.deadlineTimeEpoch))
      .limit(1);
    return rows[0] ? mapDbEventToDomain(rows[0]) : null;
  };

  const findNeighbour = async (
    season: FplSeasonRef,
    offset: number,
    label: string,
  ): Promise<DomainEvent | null> => {
    try {
      const current = await findCurrentInternal(season);
      if (!current) {
        if (offset === 1) {
          const db = await getDbInstance();
          const nowEpoch = Math.floor(Date.now() / 1000);
          const rows = await db
            .select()
            .from(eventsInFpl)
            .where(
              and(
                eq(eventsInFpl.seasonId, season.seasonId),
                isNotNull(eventsInFpl.deadlineTimeEpoch),
                gt(eventsInFpl.deadlineTimeEpoch, nowEpoch),
              ),
            )
            .orderBy(asc(eventsInFpl.deadlineTimeEpoch))
            .limit(1);
          return rows[0] ? mapDbEventToDomain(rows[0]) : null;
        }
        logInfo(`No current event - ${label} event unavailable`, { season: season.seasonCode });
        return null;
      }

      const targetId = neighbourEventId(current.id, offset);
      if (targetId === null) {
        logInfo(`${label} event out of range`, { currentId: current.id, offset });
        return null;
      }

      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(eventsInFpl)
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, targetId)))
        .limit(1);
      const event = rows[0] ? mapDbEventToDomain(rows[0]) : null;
      logInfo(event ? `Retrieved ${label} event` : `No ${label} event found`, {
        season: season.seasonCode,
        targetId,
      });
      return event;
    } catch (error) {
      logError(`Failed to find ${label} event`, error, { season: season.seasonCode });
      throw new DatabaseError(
        `Failed to retrieve ${label} event`,
        `FIND_${label.toUpperCase()}_ERROR`,
        error instanceof Error ? error : undefined,
      );
    }
  };

  return {
    findAll: async (season: FplSeasonRef): Promise<DomainEvent[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(eventsInFpl)
          .where(eq(eventsInFpl.seasonId, season.seasonId))
          .orderBy(eventsInFpl.eventId);
        return rows.map(mapDbEventToDomain);
      } catch (error) {
        logError('Failed to find all events', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve all events',
          'FIND_ALL_EVENTS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findById: async (season: FplSeasonRef, eventId: number): Promise<DomainEvent | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(eventsInFpl)
          .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
          .limit(1);
        return rows[0] ? mapDbEventToDomain(rows[0]) : null;
      } catch (error) {
        logError('Failed to find event by id', error, { season: season.seasonCode, eventId });
        throw new DatabaseError(
          'Failed to retrieve event by id',
          'FIND_EVENT_BY_ID_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findDataCheckedAtExact: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<string | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db.execute<{ exactDataCheckedAt: string | null }>(sql`
          SELECT to_char(
            ${eventsInFpl.dataCheckedAt} AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS "exactDataCheckedAt"
          FROM ${eventsInFpl}
          WHERE ${eventsInFpl.seasonId} = ${season.seasonId}
            AND ${eventsInFpl.eventId} = ${eventId}
            AND ${eventsInFpl.finished} = true
            AND ${eventsInFpl.dataChecked} = true
        `);
        return rows[0]?.exactDataCheckedAt ? String(rows[0].exactDataCheckedAt) : null;
      } catch (error) {
        logError('Failed to find exact event finalization timestamp', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve exact event finalization timestamp',
          'FIND_EVENT_FINALIZATION_TIMESTAMP_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findLiveSnapshotFinalizedAt: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<Date | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ finalizedAt: eventsInFpl.liveSnapshotFinalizedAt })
          .from(eventsInFpl)
          .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
          .limit(1);
        return rows[0]?.finalizedAt ?? null;
      } catch (error) {
        logError('Failed to find live snapshot finalization marker', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve live snapshot finalization marker',
          'FIND_LIVE_SNAPSHOT_FINALIZATION_MARKER_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findCurrent: async (season: FplSeasonRef): Promise<DomainEvent | null> => {
      try {
        return await findCurrentInternal(season);
      } catch (error) {
        logError('Failed to find current event', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve current event',
          'FIND_CURRENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findNext: async (season: FplSeasonRef): Promise<DomainEvent | null> =>
      findNeighbour(season, 1, 'next'),

    findPrevious: async (season: FplSeasonRef): Promise<DomainEvent | null> =>
      findNeighbour(season, -1, 'previous'),

    findLatestFinalized: async (season: FplSeasonRef): Promise<DomainEvent | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(eventsInFpl)
          .where(
            and(
              eq(eventsInFpl.seasonId, season.seasonId),
              eq(eventsInFpl.finished, true),
              eq(eventsInFpl.dataChecked, true),
            ),
          )
          .orderBy(desc(eventsInFpl.eventId))
          .limit(1);
        return rows[0] ? mapDbEventToDomain(rows[0]) : null;
      } catch (error) {
        logError('Failed to find latest finalized event', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve latest finalized event',
          'FIND_LATEST_FINALIZED_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      domainEvents: DomainEvent[],
    ): Promise<DomainEvent[]> => {
      try {
        if (domainEvents.length === 0) {
          return [];
        }

        const newEvents = domainEvents.map((event) => ({
          seasonId: season.seasonId,
          eventId: event.id,
          name: event.name,
          deadlineTime: event.deadlineTime,
          averageEntryScore: event.averageEntryScore,
          finished: event.finished,
          dataChecked: event.dataChecked,
          dataCheckedAt: event.dataChecked ? sql`clock_timestamp()` : null,
          highestScoringEntry: event.highestScoringEntry,
          deadlineTimeEpoch: event.deadlineTimeEpoch,
          deadlineTimeGameOffset: event.deadlineTimeGameOffset,
          highestScore: event.highestScore,
          isPrevious: event.isPrevious,
          isCurrent: event.isCurrent,
          isNext: event.isNext,
          cupLeagueCreate: event.cupLeagueCreate,
          h2HKoMatchesCreated: event.h2hKoMatchesCreated,
          chipPlays: event.chipPlays,
          mostSelected: event.mostSelected,
          mostTransferredIn: event.mostTransferredIn,
          topElement: event.topElement,
          topElementInfo: event.topElementInfo,
          transfersMade: event.transfersMade,
          mostCaptained: event.mostCaptained,
          mostViceCaptained: event.mostViceCaptained,
          updatedAt: new Date(),
        }));

        const db = await getDbInstance();
        const rows = await db
          .insert(eventsInFpl)
          .values(newEvents)
          .onConflictDoUpdate({
            target: [eventsInFpl.seasonId, eventsInFpl.eventId],
            set: {
              name: sql`excluded.name`,
              deadlineTime: sql`excluded.deadline_time`,
              averageEntryScore: sql`excluded.average_entry_score`,
              finished: sql`excluded.finished`,
              dataChecked: sql`excluded.data_checked`,
              dataCheckedAt: sql`
                CASE
                  WHEN excluded.data_checked = true
                    AND (${eventsInFpl.dataChecked} = false OR ${eventsInFpl.dataCheckedAt} IS NULL)
                  THEN clock_timestamp()
                  ELSE ${eventsInFpl.dataCheckedAt}
                END
              `,
              highestScoringEntry: sql`excluded.highest_scoring_entry`,
              deadlineTimeEpoch: sql`excluded.deadline_time_epoch`,
              deadlineTimeGameOffset: sql`excluded.deadline_time_game_offset`,
              highestScore: sql`excluded.highest_score`,
              isPrevious: sql`excluded.is_previous`,
              isCurrent: sql`excluded.is_current`,
              isNext: sql`excluded.is_next`,
              cupLeagueCreate: sql`excluded.cup_league_create`,
              h2HKoMatchesCreated: sql`excluded.h2h_ko_matches_created`,
              chipPlays: sql`excluded.chip_plays`,
              mostSelected: sql`excluded.most_selected`,
              mostTransferredIn: sql`excluded.most_transferred_in`,
              topElement: sql`excluded.top_element`,
              topElementInfo: sql`excluded.top_element_info`,
              transfersMade: sql`excluded.transfers_made`,
              mostCaptained: sql`excluded.most_captained`,
              mostViceCaptained: sql`excluded.most_vice_captained`,
              liveSnapshotFinalizedAt: sql`
                CASE
                  WHEN excluded.finished = false OR excluded.data_checked = false THEN NULL
                  WHEN ${eventsInFpl.deadlineTime} IS DISTINCT FROM excluded.deadline_time THEN NULL
                  WHEN ${eventsInFpl.dataChecked} = false AND excluded.data_checked = true THEN NULL
                  ELSE ${eventsInFpl.liveSnapshotFinalizedAt}
                END
              `,
              updatedAt: new Date(),
            },
          })
          .returning();

        logInfo('Batch upserted eventsInFpl', { count: rows.length, season: season.seasonCode });
        return rows.map(mapDbEventToDomain);
      } catch (error) {
        logError('Failed to batch upsert eventsInFpl', error, {
          count: domainEvents.length,
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to batch upsert eventsInFpl',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const eventRepository = createEventRepository();
