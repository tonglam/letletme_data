import * as TE from 'fp-ts/TaskEither';
import { EntryEventTransferCreateInputs } from 'repository/entry-event-transfer/types';
import { RawEntryEventTransfers } from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { DomainError } from 'types/error.type';

export interface EntryEventTransferOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DomainError, RawEntryEventTransfers>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ) => TE.TaskEither<DomainError, RawEntryEventTransfers>;
}
