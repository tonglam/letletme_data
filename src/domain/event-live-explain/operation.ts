import { EventLiveExplainOperations } from 'domain/event-live-explain/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EventLiveExplainCreateInputs,
  EventLiveExplainRepository,
} from 'repository/event-live-explain/types';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventLiveExplainOperations = (
  repository: EventLiveExplainRepository,
): EventLiveExplainOperations => {
  const saveEventLiveExplains = (
    eventLiveExplains: EventLiveExplainCreateInputs,
  ): TE.TaskEither<DomainError, EventLiveExplains> =>
    pipe(
      repository.saveBatchByEventId(eventLiveExplains),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteEventLiveExplains = (eventId: EventId): TE.TaskEither<DomainError, void> =>
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
    saveEventLiveExplains,
    deleteEventLiveExplains,
  };
};
