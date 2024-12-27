import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../../infrastructure/http/common/errors';
import { createFPLClient } from '../../infrastructure/http/fpl/client';
import { createTeamServiceImpl } from '../../services/teams/service';
import { teamWorkflows } from '../../services/teams/workflow';
import { Team, TeamId } from '../../types/teams.type';
import { teamRepository } from './repository';

export interface TeamOperations {
  readonly syncTeams: () => TE.TaskEither<APIError, readonly Team[]>;
  readonly getTeams: () => TE.TaskEither<APIError, readonly Team[]>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<APIError, Team>;
}

export const createTeamOperations = (): TeamOperations => {
  const bootstrapApi = createFPLClient();
  const teamService = createTeamServiceImpl({
    bootstrapApi,
    teamRepository,
  });
  const workflow = teamWorkflows(teamService);

  return {
    syncTeams: () => workflow.syncAndVerifyTeams(),
    getTeams: () => workflow.syncAndVerifyTeams(),
    getTeam: (id) => workflow.getTeamWithValidation(id),
  };
};
