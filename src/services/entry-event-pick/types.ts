import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { ServiceError } from 'src/types/error.type';

export interface EntryEventPickServiceOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventPick>;
  readonly deleteByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryEventPicksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventPickService {
  readonly getEntryEventPick: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventPick>;
  readonly deleteEntryEventPickByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryEventPicksFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventPickWorkflowOperations {
  readonly syncEntryEventPicks: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
