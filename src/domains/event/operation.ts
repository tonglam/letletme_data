import { EventOperations } from 'domains/event/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Events } from 'src/types/domain/event.type';

import { EventCreateInputs, EventRepository } from '../../repositories/event/type';
import { DomainError, DomainErrorCode, createDomainError } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEventOperations = (repository: EventRepository): EventOperations => {
  const saveEvents = (events: EventCreateInputs): TE.TaskEither<DomainError, Events> =>
    pipe(
      repository.saveBatch(events),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveEvents): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteAllEvents = (): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    saveEvents,
    deleteAllEvents,
  };
};
