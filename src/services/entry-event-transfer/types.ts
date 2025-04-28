import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryEventTransfers } from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { ServiceError } from 'types/error.type';

export interface EntryEventTransferServiceOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventTransfers>;
  readonly syncTransfersFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventTransferService {
  readonly getEntryEventTransfer: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EntryEventTransfers>;
  readonly syncTransfersFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EntryEventTransferWorkflowOperations {
  readonly syncEntryEventTransfers: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, WorkflowResult>;
}
