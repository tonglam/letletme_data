import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryEventTransfer } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { ServiceError } from 'src/types/error.type';

export interface EntryEventTransferServiceOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventTransfer>;
  readonly deleteByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryEventTransfersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventTransferService {
  readonly getEntryEventTransfer: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventTransfer>;
  readonly deleteEntryEventTransferByEntryId: (
    entryId: EntryId,
  ) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryEventTransfersFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventTransferWorkflowOperations {
  readonly syncEntryEventTransfers: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
