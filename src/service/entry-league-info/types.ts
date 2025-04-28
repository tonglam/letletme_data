import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { ServiceError } from 'types/error.type';

export interface EntryLeagueInfoServiceOperations {
  readonly findByEntryId: (id: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly syncEntryLeagueInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoService {
  readonly getEntryLeagueInfo: (id: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly syncEntryLeagueInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoWorkflowOperations {
  readonly syncEntryLeagueInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
