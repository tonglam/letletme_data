import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { TeamHandlerResponse } from 'src/api/team/types';

import { TeamService } from '../../services/team/types';
import { Team, TeamId, Teams } from '../../types/domain/team.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

export const createTeamHandlers = (teamService: TeamService): TeamHandlerResponse => {
  const getAllTeams = (): TE.TaskEither<APIError, Team[]> => {
    return pipe(
      teamService.getTeams(),
      TE.mapLeft(toAPIError),
      TE.map((teams: Teams) => [...teams]),
    );
  };

  const syncTeams = (): TE.TaskEither<APIError, void> => {
    return pipe(teamService.syncTeamsFromApi(), TE.mapLeft(toAPIError));
  };

  const getTeamById = (req: Request): TE.TaskEither<APIError, Team> => {
    const teamId = Number(req.params.id);
    if (isNaN(teamId) || teamId <= 0) {
      return TE.left<APIError>(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid team ID: must be a positive integer',
        }),
      );
    }

    return pipe(
      teamService.getTeam(teamId as TeamId),
      TE.mapLeft(toAPIError),
      TE.chain((team) =>
        team === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Team with ID ${teamId} not found`,
              }),
            )
          : TE.right(team),
      ),
    );
  };

  return {
    getAllTeams,
    syncTeams,
    getTeamById,
  };
};
