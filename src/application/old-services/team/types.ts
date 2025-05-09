import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { Team, TeamId, Teams } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface TeamServiceOperations {
  readonly findTeamById: (id: TeamId) => TE.TaskEither<ServiceError, Team>;
  readonly findAllTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface TeamService {
  readonly getTeam: (id: TeamId) => TE.TaskEither<ServiceError, Team>;
  readonly getTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface TeamWorkflowsOperations {
  readonly syncTeams: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
