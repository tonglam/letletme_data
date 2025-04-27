import * as TE from 'fp-ts/TaskEither';
import { EntryId, EntryInfo, EntryInfos } from 'src/types/domain/entry-info.type';

import { DomainError } from '../../types/error.type';

export interface EntryInfoOperations {
  readonly findById: (id: EntryId) => TE.TaskEither<DomainError, EntryInfo>;
  readonly findByIds: (entryIds: ReadonlyArray<EntryId>) => TE.TaskEither<DomainError, EntryInfos>;
  readonly upsertEntryInfo: (entryInfo: EntryInfo) => TE.TaskEither<DomainError, EntryInfo>;
}
