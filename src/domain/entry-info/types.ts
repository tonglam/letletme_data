import * as TE from 'fp-ts/TaskEither';
import { EntryId, EntryInfo, EntryInfos } from 'types/domain/entry-info.type';
import { DomainError } from 'types/error.type';

export interface EntryInfoOperations {
  readonly findById: (id: EntryId) => TE.TaskEither<DomainError, EntryInfo>;
  readonly findByIds: (ids: ReadonlyArray<EntryId>) => TE.TaskEither<DomainError, EntryInfos>;
  readonly findAllIds: () => TE.TaskEither<DomainError, ReadonlyArray<EntryId>>;
  readonly upsertEntryInfo: (entryInfo: EntryInfo) => TE.TaskEither<DomainError, EntryInfo>;
}
