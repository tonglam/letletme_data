import * as TE from 'fp-ts/TaskEither';
import { EntryEventPickCreateInputs } from 'src/repositories/entry-event-pick/types';
import { RawEntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EntryEventPickOperations {
  readonly findByEntryIdAndEventId: (
    entryId: EntryId,
    eventId: EventId,
  ) => TE.TaskEither<DomainError, RawEntryEventPick>;
  readonly saveBatchByEntryIdAndEventId: (
    entryEventPickInputs: EntryEventPickCreateInputs,
  ) => TE.TaskEither<DomainError, RawEntryEventPick>;
}
