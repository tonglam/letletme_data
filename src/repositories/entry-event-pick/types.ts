import { Prisma, EntryEventPick as PrismaEntryEventPickType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { RawEntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryEventPickCreateInput = Prisma.EntryEventPickCreateInput;
export type PrismaEntryEventPick = PrismaEntryEventPickType;

export type EntryEventPickCreateInput = RawEntryEventPick;
export type EntryEventPickCreateInputs = readonly EntryEventPickCreateInput[];

export interface EntryEventPickRepository {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DBError, RawEntryEventPick>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventPickInputs: EntryEventPickCreateInputs,
  ) => TE.TaskEither<DBError, RawEntryEventPick>;
  readonly deleteByEntryId: (entryId: EntryId) => TE.TaskEither<DBError, void>;
}
