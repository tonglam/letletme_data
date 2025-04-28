import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-event-transfer';
import {
  RawEntryEventTransfer,
  RawEntryEventTransfers,
} from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { DBError } from 'types/error.type';

export type DbEntryEventTransfer = InferSelectModel<typeof schema.entryEventTransfers>;
export type DbEntryEventTransferCreateInput = InferInsertModel<typeof schema.entryEventTransfers>;

export type EntryEventTransferCreateInput = RawEntryEventTransfer;
export type EntryEventTransferCreateInputs = readonly EntryEventTransferCreateInput[];

export interface EntryEventTransferRepository {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DBError, RawEntryEventTransfers>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ) => TE.TaskEither<DBError, RawEntryEventTransfers>;
}
