import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventLiveExplainToPrismaCreate,
  mapPrismaEventLiveExplainToDomain,
} from 'src/repositories/event-live-explain/mapper';
import {
  EventLiveExplainCreateInputs,
  EventLiveExplainRepository,
} from 'src/repositories/event-live-explain/type';
import { EventLiveExplains, EventLiveExplain } from 'src/types/domain/event-live-explain.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEventLiveExplainRepository = (
  prisma: PrismaClient,
): EventLiveExplainRepository => {
  const findByElementIdAndEventId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<DBError, EventLiveExplain> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.eventLiveExplain.findUnique({
            where: { unique_event_element_live_explain: { eventId, elementId } },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explain by element id ${elementId} and event id ${eventId}: ${error}`,
          }),
      ),
      TE.chain((prismaEventLiveExplain) =>
        prismaEventLiveExplain
          ? TE.right(mapPrismaEventLiveExplainToDomain(prismaEventLiveExplain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event live explain with element id ${elementId} and event id ${eventId} not found in database`,
              }),
            ),
      ),
    );

  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, EventLiveExplains> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventLiveExplain.findMany({ where: { eventId } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explains by event id ${eventId}: ${error}`,
          }),
      ),
      TE.map((prismaEventLiveExplains) =>
        prismaEventLiveExplains.map(mapPrismaEventLiveExplainToDomain),
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
          const dataToCreate = eventLiveExplainInputs.map(mapDomainEventLiveExplainToPrismaCreate);
          await prisma.eventLiveExplain.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event live in batch: ${error}`,
          }),
      ),
      TE.chainW(() => findByEventId(eventId)),
    );
  };

  const deleteByEventId = (eventId: EventId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.eventLiveExplain.deleteMany({ where: { eventId } });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event live explain by event id ${eventId}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByElementIdAndEventId,
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
