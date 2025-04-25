import { EventFixtureOperations } from 'domains/event-fixture/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EventFixtureCreateInputs,
  EventFixtureRepository,
} from 'src/repositories/event-fixture/types';
import { RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';

import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEventFixtureOperations = (
  repository: EventFixtureRepository,
): EventFixtureOperations => {
  const saveEventFixtures = (
    eventFixtures: EventFixtureCreateInputs,
  ): TE.TaskEither<DomainError, RawEventFixtures> =>
    pipe(
      repository.saveBatchByEventId(eventFixtures),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteEventFixtures = (eventId: EventId): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteByEventId(eventId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteByEventId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    saveEventFixtures,
    deleteEventFixtures,
  };
};
