import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';

import type { Team, TeamId, Teams } from '../../types/domain/team.type';
import type { ServiceError } from '../../types/error.type';

export interface TeamServiceOperations {
  readonly findAllTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly findTeamById: (id: TeamId) => TE.TaskEither<ServiceError, Team>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface TeamService {
  readonly getTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<ServiceError, Team>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface TeamWorkflowsOperations {
  readonly syncTeams: () => TE.TaskEither<ServiceError, WorkflowResult<Teams>>;
}
