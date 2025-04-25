import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { TeamId } from 'src/types/domain/team.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

import { mapDomainEventFixtureToPrismaCreate, mapPrismaEventFixtureToDomain } from './mapper';
import { EventFixtureCreateInputs, EventFixtureRepository } from './types';

export const createEventFixtureRepository = (prisma: PrismaClient): EventFixtureRepository => {
  const findByTeamId = (teamId: TeamId): TE.TaskEither<DBError, RawEventFixtures> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.eventFixture.findMany({
            where: { OR: [{ teamH: Number(teamId) }, { teamA: Number(teamId) }] },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find event fixture by team id ${teamId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEventFixturesOrNull) =>
        prismaEventFixturesOrNull
          ? TE.right(prismaEventFixturesOrNull.map(mapPrismaEventFixtureToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event fixture with team id ${teamId} not found in database`,
              }),
            ),
      ),
    );

  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, RawEventFixtures> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventFixture.findMany({ where: { eventId: Number(eventId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find event fixture by event id ${eventId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEventFixturesOrNull) =>
        prismaEventFixturesOrNull
          ? TE.right(prismaEventFixturesOrNull.map(mapPrismaEventFixtureToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Event fixture with event id ${eventId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByEventId = (
    eventFixtureInputs: EventFixtureCreateInputs,
  ): TE.TaskEither<DBError, RawEventFixtures> => {
    if (eventFixtureInputs.length === 0) {
      return TE.right([]);
    }
    const eventId = eventFixtureInputs[0].eventId as EventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = eventFixtureInputs.map(mapDomainEventFixtureToPrismaCreate);
          await prisma.eventFixture.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save event fixture batch for event id ${eventId}: ${error}`,
          }),
      ),
      TE.chainW(() => findByEventId(eventId)),
    );
  };

  const deleteByEventId = (eventId: EventId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.eventFixture.deleteMany({ where: { eventId: Number(eventId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event fixture by event id ${eventId}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByTeamId,
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
