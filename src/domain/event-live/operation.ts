import { EventLiveOperations } from 'domain/event-live/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveCreateInputs, EventLiveRepository } from 'repository/event-live/types';
import { RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventLiveOperations = (repository: EventLiveRepository): EventLiveOperations => {
  const saveEventLives = (
    eventLives: EventLiveCreateInputs,
  ): TE.TaskEither<DomainError, RawEventLives> =>
    pipe(
      repository.saveBatchByEventId(eventLives),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteEventLives = (eventId: EventId): TE.TaskEither<DomainError, void> =>
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
    saveEventLives,
    deleteEventLives,
  };
};
