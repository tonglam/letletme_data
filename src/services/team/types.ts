import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { FplBootstrapDataService } from 'src/data/types';
import type { Team, TeamId, Teams } from '../../types/domain/team.type';
import type { ServiceError } from '../../types/error.type';

export interface TeamService {
  readonly getTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<ServiceError, Team | null>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, Teams>;
}

export interface TeamServiceWithWorkflows extends TeamService {
  readonly workflows: {
    readonly syncTeams: () => TE.TaskEither<ServiceError, WorkflowResult<Teams>>;
  };
}

export interface TeamServiceOpDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface TeamServiceOperations {
  readonly findAllTeams: () => TE.TaskEither<ServiceError, Teams>;
  readonly findTeamById: (id: TeamId) => TE.TaskEither<ServiceError, Team | null>;
  readonly syncTeamsFromApi: () => TE.TaskEither<ServiceError, Teams>;
}
