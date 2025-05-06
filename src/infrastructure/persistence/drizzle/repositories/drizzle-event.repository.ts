import { Event } from '@app/domain/event/model';
import { EventRepository } from '@app/domain/event/repository';
import { EventID } from '@app/domain/shared/types/id.types';
import { db } from '@app/infrastructure/persistence/drizzle';
import { toDomain, toPersistence } from '@app/infrastructure/persistence/mappers/event.mapper';
import { DbEventInsert, events } from '@app/schemas/tables/event.schema';
import { DBError, DBErrorCode, createDBError } from '@app/types/error.types';
import { getErrorMessage } from '@app/utils/error.util';
import { eq } from 'drizzle-orm';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createEventRepository = (): EventRepository => {
  const findById = (id: EventID): TE.TaskEither<DBError, Event> =>
    TE.tryCatch(
      async () => {
        const result = await db
          .select()
          .from(events)
          .where(eq(events.id, Number(id)))
          .limit(1);
        const dbEvent = result[0];

        if (!dbEvent) {
          throw createDBError({
            code: DBErrorCode.NOT_FOUND,
            message: `Event with id ${id} not found`,
          });
        }

        const domainEvent = toDomain(dbEvent);
        if (E.isLeft(domainEvent)) {
          throw domainEvent.left;
        }
        return domainEvent.right;
      },
      (error) => {
        if (error instanceof Error && '_tag' in error && error._tag === 'DBError') {
          return error as DBError;
        }
        return createDBError({
          code: DBErrorCode.QUERY_ERROR,
          message: `Failed to fetch event by id ${id}: ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        });
      },
    );

  const findCurrent = (): TE.TaskEither<DBError, Event> =>
    TE.tryCatch(
      async () => {
        const result = await db.select().from(events).where(eq(events.isCurrent, true)).limit(1);
        const dbEvent = result[0];

        if (!dbEvent) {
          throw createDBError({
            code: DBErrorCode.NOT_FOUND,
            message: 'Current event not found',
          });
        }

        const domainEvent = toDomain(dbEvent);
        if (E.isLeft(domainEvent)) {
          throw domainEvent.left;
        }
        return domainEvent.right;
      },
      (error) => {
        if (error instanceof Error && '_tag' in error && error._tag === 'DBError') {
          return error as DBError;
        }
        return createDBError({
          code: DBErrorCode.QUERY_ERROR,
          message: `Failed to fetch current event: ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        });
      },
    );

  const findAll = (): TE.TaskEither<DBError, Event[]> =>
    TE.tryCatch(
      async () => {
        const dbEvents = await db.select().from(events).orderBy(events.id);
        const domainEvents: Event[] = [];
        for (const dbEvent of dbEvents) {
          const domainEvent = toDomain(dbEvent);
          if (E.isLeft(domainEvent)) {
            throw domainEvent.left;
          }
          domainEvents.push(domainEvent.right);
        }
        return domainEvents;
      },
      (error) => {
        if (error instanceof Error && '_tag' in error && error._tag === 'DBError') {
          return error as DBError;
        }
        return createDBError({
          code: DBErrorCode.QUERY_ERROR,
          message: `Failed to fetch all events: ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        });
      },
    );

  const saveBatch = (domainEvents: Event[]): TE.TaskEither<DBError, Event[]> =>
    TE.tryCatch(
      async () => {
        if (domainEvents.length === 0) {
          return [];
        }
        const eventInserts: DbEventInsert[] = domainEvents.map(toPersistence);
        await db.insert(events).values(eventInserts).onConflictDoNothing();
        return domainEvents;
      },
      (error) =>
        createDBError({
          code: DBErrorCode.QUERY_ERROR,
          message: `Failed to save events in batch: ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(events);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all events: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findById,
    findCurrent,
    findAll,
    saveBatch,
    deleteAll,
  };
};
