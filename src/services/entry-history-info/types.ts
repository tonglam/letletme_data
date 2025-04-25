import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { ServiceError } from 'src/types/error.type';

export interface EntryHistoryInfoServiceOperations {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly deleteByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryHistoryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoService {
  readonly getEntryHistoryInfo: (
    entryId: EntryId,
  ) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly deleteEntryHistoryInfoByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryHistoryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoWorkflowOperations {
  readonly syncEntryHistoryInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
