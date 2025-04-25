import * as TE from 'fp-ts/TaskEither';
import { EntryId, EntryInfo, EntryInfos } from 'src/types/domain/entry-info.type';

import { EntryInfoCreateInput } from '../../repositories/entry-info/types';
import { DomainError } from '../../types/error.type';

export interface EntryInfoOperations {
  readonly findById: (id: EntryId) => TE.TaskEither<DomainError, EntryInfo>;
  readonly findByIds: (entryIds: ReadonlyArray<EntryId>) => TE.TaskEither<DomainError, EntryInfos>;
  readonly upsertEntryInfo: (
    entryInfoInput: EntryInfoCreateInput,
  ) => TE.TaskEither<DomainError, EntryInfo>;
  readonly deleteById: (id: EntryId) => TE.TaskEither<DomainError, void>;
}
