import { eq, sql } from 'drizzle-orm';

import { events, type DbEvent, type DbEventInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Event as DomainEvent } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createEventRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findCurrent: async (): Promise<DbEvent | null> => {
      try {
        const db = await getDbInstance();
        const result = await db.select().from(events).where(eq(events.isCurrent, true));
        const event = result[0] || null;

        if (event) {
          logInfo('Retrieved current event', { id: event.id });
        } else {
          logInfo('No current event found');
        }

        return event;
      } catch (error) {
        logError('Failed to find current event', error);
        throw new DatabaseError(
          'Failed to retrieve current event',
          'FIND_CURRENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findNext: async (): Promise<DbEvent | null> => {
      try {
        const db = await getDbInstance();
        const result = await db.select().from(events).where(eq(events.isNext, true));
        const event = result[0] || null;

        if (event) {
          logInfo('Retrieved next event', { id: event.id });
        } else {
          logInfo('No next event found');
        }

        return event;
      } catch (error) {
        logError('Failed to find next event', error);
        throw new DatabaseError(
          'Failed to retrieve next event',
          'FIND_NEXT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (domainEvents: DomainEvent[]): Promise<DbEvent[]> => {
      try {
        if (domainEvents.length === 0) {
          return [];
        }

        const newEvents: DbEventInsert[] = domainEvents.map((event) => ({
          id: event.id,
          name: event.name,
          deadlineTime: event.deadlineTime,
          averageEntryScore: event.averageEntryScore,
          finished: event.finished,
          dataChecked: event.dataChecked,
          highestScoringEntry: event.highestScoringEntry,
          deadlineTimeEpoch: event.deadlineTimeEpoch,
          deadlineTimeGameOffset: event.deadlineTimeGameOffset,
          highestScore: event.highestScore,
          isPrevious: event.isPrevious,
          isCurrent: event.isCurrent,
          isNext: event.isNext,
          cupLeagueCreate: event.cupLeagueCreate,
          h2hKoMatchesCreated: event.h2hKoMatchesCreated,
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
        const result = await db
          .insert(events)
          .values(newEvents)
          .onConflictDoUpdate({
            target: events.id,
            set: {
              name: sql`excluded.name`,
              deadlineTime: sql`excluded.deadline_time`,
              averageEntryScore: sql`excluded.average_entry_score`,
              finished: sql`excluded.finished`,
              dataChecked: sql`excluded.data_checked`,
              highestScoringEntry: sql`excluded.highest_scoring_entry`,
              deadlineTimeEpoch: sql`excluded.deadline_time_epoch`,
              deadlineTimeGameOffset: sql`excluded.deadline_time_game_offset`,
              highestScore: sql`excluded.highest_score`,
              isPrevious: sql`excluded.is_previous`,
              isCurrent: sql`excluded.is_current`,
              isNext: sql`excluded.is_next`,
              cupLeagueCreate: sql`excluded.cup_league_create`,
              h2hKoMatchesCreated: sql`excluded.h2h_ko_matches_created`,
              chipPlays: sql`excluded.chip_plays`,
              mostSelected: sql`excluded.most_selected`,
              mostTransferredIn: sql`excluded.most_transferred_in`,
              topElement: sql`excluded.top_element`,
              topElementInfo: sql`excluded.top_element_info`,
              transfersMade: sql`excluded.transfers_made`,
              mostCaptained: sql`excluded.most_captained`,
              mostViceCaptained: sql`excluded.most_vice_captained`,
              updatedAt: new Date(),
            },
          })
          .returning();

        logInfo('Batch upserted events', { count: result.length });
        return result;
      } catch (error) {
        logError('Failed to batch upsert events', error, { count: domainEvents.length });
        throw new DatabaseError(
          'Failed to batch upsert events',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const eventRepository = createEventRepository();
