import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventFixtureToPrismaCreate,
  mapPrismaEventFixtureToDomain,
} from 'src/repositories/event-fixture/mapper';
import {
  EventFixtureId,
  SourceEventFixture,
  SourceEventFixtures,
} from 'src/types/domain/event-fixture.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

import { EventFixtureCreateInputs, EventFixtureRepository } from './type';

export const createEventFixtureRepository = (prisma: PrismaClient): EventFixtureRepository => {
  const findById = (id: EventFixtureId): TE.TaskEither<DBError, SourceEventFixture> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventFixture.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event fixture by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaEventFixtureOrNull) =>
        prismaEventFixtureOrNull
          ? TE.right(mapPrismaEventFixtureToDomain(prismaEventFixtureOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event fixture with id ${id} not found`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, SourceEventFixtures> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventFixture.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all event fixtures: ${error}`,
          }),
      ),
      TE.map((prismaEventFixtures) => prismaEventFixtures.map(mapPrismaEventFixtureToDomain)),
    );

  const saveBatch = (
    eventFixtures: EventFixtureCreateInputs,
  ): TE.TaskEither<DBError, SourceEventFixtures> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = eventFixtures.map(mapDomainEventFixtureToPrismaCreate);
          await prisma.eventFixture.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event fixtures in batch: ${error}`,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventFixture.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all event fixtures: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
