import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainEventLiveToDbCreate, mapDbEventLiveToDomain } from 'repository/event-live/mapper';
import { EventLiveCreateInputs, EventLiveRepository } from 'repository/event-live/types';
import * as schema from 'schema/event-live';
import { RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';
export const createEventLiveRepository = (): EventLiveRepository => {
  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, RawEventLives> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventLive)
            .where(eq(schema.eventLive.eventId, Number(eventId)));
          return result.map(mapDbEventLiveToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEventId = (
    eventLiveInputs: EventLiveCreateInputs,
  ): TE.TaskEither<DBError, RawEventLives> => {
    if (eventLiveInputs.length === 0) {
      return TE.right([]);
    }
    const eventId = eventLiveInputs[0].eventId as EventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = eventLiveInputs.map(mapDomainEventLiveToDbCreate);
          await db
            .insert(schema.eventLive)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.eventLive.eventId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event live in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chainW(() => findByEventId(eventId)),
    );
  };

  const deleteByEventId = (eventId: EventId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db.delete(schema.eventLive).where(eq(schema.eventLive.eventId, Number(eventId)));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event live by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
