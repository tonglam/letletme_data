import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { ServiceError } from 'types/error.type';

export interface EntryHistoryInfoServiceOperations {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly findAllEntryIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly syncEntryHistoryInfosFromApi: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncHistoryInfosFromApi: (
    entryIds: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoService {
  readonly getEntryHistoryInfo: (
    entryId: EntryId,
  ) => TE.TaskEither<ServiceError, EntryHistoryInfos>;
  readonly getAllEntryIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly syncEntryHistoryInfosFromApi: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncHistoryInfosFromApi: (
    entryIds: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryHistoryInfoWorkflowOperations {
  readonly syncHistoryInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
