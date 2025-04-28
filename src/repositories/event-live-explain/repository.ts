import { db } from 'db/index';
import { and, eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventLiveExplainToDbCreate,
  mapDbEventLiveExplainToDomain,
} from 'repositories/event-live-explain/mapper';
import {
  EventLiveExplainCreateInputs,
  EventLiveExplainRepository,
} from 'repositories/event-live-explain/types';
import * as schema from 'schema/event-live-explain';
import { EventLiveExplains, EventLiveExplain } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventLiveExplainRepository = (): EventLiveExplainRepository => {
  const findByElementIdAndEventId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<DBError, EventLiveExplain> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventLiveExplains)
            .where(
              and(
                eq(schema.eventLiveExplains.eventId, Number(eventId)),
                eq(schema.eventLiveExplains.elementId, Number(elementId)),
              ),
            )
            .limit(1);
          return mapDbEventLiveExplainToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explain by element id ${elementId} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, EventLiveExplains> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventLiveExplains)
            .where(eq(schema.eventLiveExplains.eventId, Number(eventId)));
          return result.map(mapDbEventLiveExplainToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explains by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEventId = (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ): TE.TaskEither<DBError, EventLiveExplains> => {
    if (eventLiveExplainInputs.length === 0) {
      return TE.right([]);
    }
    const eventId = eventLiveExplainInputs[0].eventId as EventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = eventLiveExplainInputs.map(mapDomainEventLiveExplainToDbCreate);
          await db
            .insert(schema.eventLiveExplains)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.eventLiveExplains.eventId, schema.eventLiveExplains.elementId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event live explain in batch: ${error}`,
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
          await db
            .delete(schema.eventLiveExplains)
            .where(eq(schema.eventLiveExplains.eventId, Number(eventId)));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event live explain by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findByElementIdAndEventId,
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
