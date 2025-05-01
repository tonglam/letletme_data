import { db } from 'db/index';
import { eq, or } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDbEventFixtureToDomain,
  mapDomainEventFixtureToDbCreate,
} from 'repository/event-fixture/mapper';
import { EventFixtureCreateInputs, EventFixtureRepository } from 'repository/event-fixture/types';
import * as schema from 'schema/event-fixture.schema';
import { RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventFixtureRepository = (): EventFixtureRepository => {
  const findByTeamId = (teamId: TeamId): TE.TaskEither<DBError, RawEventFixtures> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventFixtures)
            .where(
              or(
                eq(schema.eventFixtures.teamHId, Number(teamId)),
                eq(schema.eventFixtures.teamAId, Number(teamId)),
              ),
            );
          return result.map(mapDbEventFixtureToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find event fixture by team id ${teamId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, RawEventFixtures> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventFixtures)
            .where(eq(schema.eventFixtures.eventId, Number(eventId)));
          return result.map(mapDbEventFixtureToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to find event fixture by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
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
          const dataToCreate = eventFixtureInputs.map(mapDomainEventFixtureToDbCreate);
          await db
            .insert(schema.eventFixtures)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [
                schema.eventFixtures.eventId,
                schema.eventFixtures.teamHId,
                schema.eventFixtures.teamAId,
              ],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save event fixture batch for event id ${eventId}: ${getErrorMessage(error)}`,
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
            .delete(schema.eventFixtures)
            .where(eq(schema.eventFixtures.eventId, Number(eventId)));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event fixture by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findByTeamId,
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
