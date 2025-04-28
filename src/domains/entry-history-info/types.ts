import * as TE from 'fp-ts/TaskEither';
import { EntryHistoryInfoCreateInputs } from 'repositories/entry-history-info/types';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { DomainError } from 'types/error.type';

export interface EntryHistoryInfoOperations {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DomainError, EntryHistoryInfos>;
  readonly saveBatchByEntryId: (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ) => TE.TaskEither<DomainError, EntryHistoryInfos>;
}
