import * as TE from 'fp-ts/TaskEither';
import { EntryEventTransferCreateInputs } from 'src/repositories/entry-event-transfer/types';
import { RawEntryEventTransfers } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EntryEventTransferOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DomainError, RawEntryEventTransfers>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ) => TE.TaskEither<DomainError, RawEntryEventTransfers>;
  readonly deleteByEntryId: (entryId: EntryId) => TE.TaskEither<DomainError, void>;
}
