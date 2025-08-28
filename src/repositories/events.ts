import { eq, sql } from 'drizzle-orm';

import { events, type DbEvent } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Event as DomainEvent } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EventRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }
  async findAll(): Promise<DbEvent[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(events);
      logInfo('Retrieved all events', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find all events', error);
      throw new DatabaseError(
        'Failed to retrieve events',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findById(id: number): Promise<DbEvent | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(events).where(eq(events.id, id));
      const event = result[0] || null;

      if (event) {
        logInfo('Retrieved event by id', { id });
      } else {
        logInfo('Event not found', { id });
      }

      return event;
    } catch (error) {
      logError('Failed to find event by id', error, { id });
      throw new DatabaseError(
        `Failed to retrieve event with id: ${id}`,
        'FIND_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findCurrent(): Promise<DbEvent | null> {
    try {
      const db = await this.getDbInstance();
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
  }

  async findNext(): Promise<DbEvent | null> {
    try {
      const db = await this.getDbInstance();
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
  }

  async upsert(event: DomainEvent): Promise<DbEvent> {
    try {
      const newEvent: DbEventInsert = {
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
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(events)
        .values(newEvent)
        .onConflictDoUpdate({
          target: events.id,
          set: {
            ...newEvent,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedEvent = result[0];
      logInfo('Upserted event', { id: upsertedEvent.id });
      return upsertedEvent;
    } catch (error) {
      logError('Failed to upsert event', error, { id: event.id });
      throw new DatabaseError(
        `Failed to upsert event with id: ${event.id}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(domainEvents: DomainEvent[]): Promise<DbEvent[]> {
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

      const db = await this.getDbInstance();
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
  }

  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(events);
      logInfo('Deleted all events');
    } catch (error) {
      logError('Failed to delete all events', error);
      throw new DatabaseError(
        'Failed to delete all events',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const eventRepository = new EventRepository();
