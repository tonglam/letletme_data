import { Prisma, EntryEventTransfer as PrismaEntryEventTransferType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import {
  RawEntryEventTransfer,
  RawEntryEventTransfers,
} from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryEventTransferCreateInput = Prisma.EntryEventTransferCreateInput;
export type PrismaEntryEventTransfer = PrismaEntryEventTransferType;

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
