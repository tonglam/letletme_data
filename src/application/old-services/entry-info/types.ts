import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryId, EntryInfo, EntryInfos } from 'types/domain/entry-info.type';
import { ServiceError } from 'types/error.type';

export interface EntryInfoServiceOperations {
  readonly findById: (id: EntryId) => TE.TaskEither<ServiceError, EntryInfo>;
  readonly findByIds: (ids: ReadonlyArray<EntryId>) => TE.TaskEither<ServiceError, EntryInfos>;
  readonly findAllIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly syncEntryInfoFromApi: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryInfosFromApi: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryInfoService {
  readonly getEntryInfo: (id: EntryId) => TE.TaskEither<ServiceError, EntryInfo>;
  readonly getEntryInfoByIds: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, EntryInfos>;
  readonly getAllEntryIds: () => TE.TaskEither<ServiceError, ReadonlyArray<EntryId>>;
  readonly syncEntryInfoFromApi: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryInfosFromApi: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryInfoWorkflowOperations {
  readonly syncEntryInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
