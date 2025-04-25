import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';
import { ServiceError } from 'src/types/error.type';

export interface EntryLeagueInfoServiceOperations {
  readonly findByEntryId: (id: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly deleteByEntryId: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryLeagueInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoService {
  readonly getEntryLeagueInfo: (id: EntryId) => TE.TaskEither<ServiceError, EntryLeagueInfos>;
  readonly deleteEntryLeagueInfo: (id: EntryId) => TE.TaskEither<ServiceError, void>;
  readonly syncEntryLeagueInfosFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EntryLeagueInfoWorkflowOperations {
  readonly syncEntryLeagueInfos: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
