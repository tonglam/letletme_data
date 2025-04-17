import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventId } from 'src/types/domain/event.type';

import { mapDomainEventToPrismaCreate, mapPrismaEventToDomain } from './mapper';
import { PrismaEventCreate } from './type';
import { EventRepository } from '../../domains/event/types';
import { createDBError, DBErrorCode } from '../../types/error.type';

export const createEventRepository = (prisma: PrismaClient): EventRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all events: ${error}`,
          }),
      ),
      TE.map((prismaEvents) => prismaEvents.map(mapPrismaEventToDomain)),
    ),

  findById: (id: EventId) =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event by id ${id}: ${error}`,
          }),
      ),
      TE.map((prismaEvent) => (prismaEvent ? mapPrismaEventToDomain(prismaEvent) : null)),
    ),

  findCurrent: () =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findFirst({ where: { isCurrent: true } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch current event: ${error}`,
          }),
      ),
      TE.map((prismaEvent) => (prismaEvent ? mapPrismaEventToDomain(prismaEvent) : null)),
    ),

  findNext: () =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findFirst({ where: { isNext: true } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch next event: ${error}`,
          }),
      ),
      TE.map((prismaEvent) => (prismaEvent ? mapPrismaEventToDomain(prismaEvent) : null)),
    ),

  saveBatch: (events: readonly PrismaEventCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = events.map(mapDomainEventToPrismaCreate);
          await prisma.event.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });

          const ids = events.map((e) => Number(e.id));

          return prisma.event.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create events in batch: ${error}`,
          }),
      ),
      TE.map((prismaEvents) => prismaEvents.map(mapPrismaEventToDomain)),
    ),

  deleteAll: () =>
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
