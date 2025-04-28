import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { ServiceError } from 'types/error.type';

export interface EntryHistoryInfoServiceOperations {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly syncEntryHistoryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoService {
  readonly getEntryHistoryInfo: (
    entryId: EntryId,
  ) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly syncEntryHistoryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoWorkflowOperations {
  readonly syncEntryHistoryInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
