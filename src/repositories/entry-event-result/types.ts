import { Prisma, EntryEventResult as PrismaEntryEventResultType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import {
  RawEntryEventResult,
  RawEntryEventResults,
} from 'src/types/domain/entry-event-result.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryEventResultCreateInput = Prisma.EntryEventResultCreateInput;
export type PrismaEntryEventResult = PrismaEntryEventResultType;

export type EntryEventResultCreateInput = RawEntryEventResult;
export type EntryEventResultCreateInputs = readonly EntryEventResultCreateInput[];

export interface EntryEventResultRepository {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DBError, RawEntryEventResult>;
  readonly findByEntryIdsAndEventId: (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ) => TE.TaskEither<DBError, RawEntryEventResults>;
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DBError, RawEntryEventResults>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventResultInputs: EntryEventResultCreateInputs,
  ) => TE.TaskEither<DBError, RawEntryEventResult>;
}
