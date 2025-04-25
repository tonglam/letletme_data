import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryId, EntryInfo, EntryInfos } from 'src/types/domain/entry-info.type';
import { ServiceError } from 'src/types/error.type';

export interface EntryInfoServiceOperations {
  readonly findById: (id: EntryId) => TE.TaskEither<ServiceError, EntryInfo>;
  readonly findByIds: (ids: ReadonlyArray<EntryId>) => TE.TaskEither<ServiceError, EntryInfos>;
  readonly deleteById: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryInfoService {
  readonly getEntryInfo: (id: EntryId) => TE.TaskEither<ServiceError, EntryInfo>;
  readonly getEntryInfoByIds: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, EntryInfos>;
  readonly deleteEntryInfoById: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryInfoWorkflowOperations {
  readonly syncEntryInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
