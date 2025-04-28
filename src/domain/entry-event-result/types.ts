import * as TE from 'fp-ts/TaskEither';
import { EntryEventResultCreateInputs } from 'repository/entry-event-result/types';
import { RawEntryEventResult, RawEntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { DomainError } from 'types/error.type';

export interface EntryEventResultOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DomainError, RawEntryEventResult>;
  readonly findByEntryIdsAndEventId: (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ) => TE.TaskEither<DomainError, RawEntryEventResults>;
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DomainError, RawEntryEventResults>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventResultInputs: EntryEventResultCreateInputs,
  ) => TE.TaskEither<DomainError, RawEntryEventResult>;
}
