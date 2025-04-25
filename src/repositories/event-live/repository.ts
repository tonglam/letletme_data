import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventLiveToPrismaCreate,
  mapPrismaEventLiveToDomain,
} from 'src/repositories/event-live/mapper';
import { EventLiveCreateInputs, EventLiveRepository } from 'src/repositories/event-live/type';
import { RawEventLives } from 'src/types/domain/event-live.type';
import { EventId } from 'src/types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEventLiveRepository = (prisma: PrismaClient): EventLiveRepository => {
  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, RawEventLives> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventLive.findMany({ where: { eventId: Number(eventId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live by event id ${eventId}: ${error}`,
          }),
      ),
      TE.chain((prismaEventLives) =>
        prismaEventLives
          ? TE.right(prismaEventLives.map(mapPrismaEventLiveToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event live with event id ${eventId} not found in database`,
              }),
            ),
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
          const dataToCreate = eventLiveInputs.map(mapDomainEventLiveToPrismaCreate);
          await prisma.eventLive.createMany({
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
          await prisma.eventLive.deleteMany({ where: { eventId } });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event live by event id ${eventId}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
