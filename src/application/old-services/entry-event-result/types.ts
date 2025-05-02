import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryEventResult, EntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { ServiceError } from 'types/error.type';

export interface EntryEventResultServiceOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventResult>;
  readonly findByEntryIdsAndEventId: (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventResults>;
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryEventResults>;
  readonly syncResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventResultService {
  readonly getEntryEventResult: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventResult>;
  readonly findByEntryIdsAndEventId: (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventResults>;
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryEventResults>;
  readonly syncResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventResultWorkflowOperations {
  readonly syncEntryEventResults: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
}
