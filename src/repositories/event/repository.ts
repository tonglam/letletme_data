import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventToPrismaCreate,
  mapPrismaEventToDomain,
} from 'src/repositories/event/mapper';
import { EventCreateInputs, EventRepository } from 'src/repositories/event/type';
import { Event, EventId, Events } from 'src/types/domain/event.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createEventRepository = (prisma: PrismaClient): EventRepository => ({
  findById: (id: EventId): TE.TaskEither<DBError, Event> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaEventOrNull) =>
        prismaEventOrNull
          ? TE.right(mapPrismaEventToDomain(prismaEventOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event with ID ${id} not found in database`,
              }),
            ),
      ),
    ),

  findCurrent: (): TE.TaskEither<DBError, Event> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findFirst({ where: { isCurrent: true } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch current event (isCurrent: true): ${error}`,
          }),
      ),
      TE.chainW((prismaEventOrNull) =>
        prismaEventOrNull
          ? TE.right(mapPrismaEventToDomain(prismaEventOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: 'No event found with isCurrent: true.',
              }),
            ),
      ),
    ),

  findAll: (): TE.TaskEither<DBError, Events> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findMany({ orderBy: { deadlineTime: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all events: ${error}`,
          }),
      ),
      TE.map((prismaEvents) => prismaEvents.map(mapPrismaEventToDomain)),
    ),

  saveBatch: (events: EventCreateInputs): TE.TaskEither<DBError, Events> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = events.map(mapDomainEventToPrismaCreate);
          await prisma.event.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
          return events;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create events in batch: ${error}`,
          }),
      ),
    ),

  deleteAll: (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all events: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
