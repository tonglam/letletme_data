import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { ServiceError } from 'types/error.type';

export interface EntryLeagueInfoServiceOperations {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly syncEntryLeagueInfosFromApi: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncLeaguesInfosFromApi: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoService {
  readonly getEntryLeagueInfo: (entryId: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly syncEntryLeagueInfosFromApi: (entryId: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncLeaguesInfosFromApi: (
    ids: ReadonlyArray<EntryId>,
  ) => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoWorkflowOperations {
  readonly syncLeagueInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
