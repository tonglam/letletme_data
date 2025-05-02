import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryEventPick } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { ServiceError } from 'types/error.type';

export interface EntryEventPickServiceOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventPick>;
  readonly syncPicksFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventPickService {
  readonly getEntryEventPick: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventPick>;
  readonly syncPicksFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventPickWorkflowOperations {
  readonly syncEntryEventPicks: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
}
