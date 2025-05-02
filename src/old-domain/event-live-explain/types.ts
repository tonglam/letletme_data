import * as TE from 'fp-ts/TaskEither';
import { EventLiveExplainCreateInputs } from 'repository/event-live-explain/types';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { DomainError } from 'types/error.type';

export interface EventLiveExplainOperations {
  readonly saveEventLiveExplains: (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ) => TE.TaskEither<DomainError, EventLiveExplains>;
  readonly deleteEventLiveExplains: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}
