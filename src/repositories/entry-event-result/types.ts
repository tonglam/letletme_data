import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-event-result';
import { RawEntryEventResult, RawEntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { DBError } from 'types/error.type';

export type DbEntryEventResult = InferSelectModel<typeof schema.entryEventResults>;
export type DbEntryEventResultCreateInput = InferInsertModel<typeof schema.entryEventResults>;

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
