import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-event-pick';
import { RawEntryEventPick } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { DBError } from 'types/error.type';

export type DbEntryEventPick = InferSelectModel<typeof schema.entryEventPicks>;
export type DbEntryEventPickCreateInput = InferInsertModel<typeof schema.entryEventPicks>;

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
}
