import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainEventToDbCreate, mapDbEventToDomain } from 'repository/event/mapper';
import { EventCreateInputs, EventRepository } from 'repository/event/types';
import * as schema from 'schema/event';
import { Event, EventId, Events } from 'types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventRepository = (): EventRepository => {
  const findById = (id: EventId): TE.TaskEither<DBError, Event> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.events)
            .where(eq(schema.events.id, Number(id)))
            .limit(1);
          return mapDbEventToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findCurrent = (): TE.TaskEither<DBError, Event> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.events)
            .where(eq(schema.events.isCurrent, true))
            .limit(1);
          return mapDbEventToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch current event (isCurrent: true): ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Events> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dbEvents = await db.select().from(schema.events).orderBy(schema.events.id);
          return dbEvents.map(mapDbEventToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all events: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatch = (eventInputs: EventCreateInputs): TE.TaskEither<DBError, Events> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToInsert = eventInputs.map(mapDomainEventToDbCreate);

          if (dataToInsert.length === 0) {
            return;
          }

          await db.insert(schema.events).values(dataToInsert).onConflictDoNothing();
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create events in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(schema.events);
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
