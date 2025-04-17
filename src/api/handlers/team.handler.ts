import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { ServiceContainer } from '../../services/types';
import { Team, TeamId } from '../../types/domain/team.type';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { TeamHandlerResponse } from '../types';

export const createTeamHandlers = (
  teamService: ServiceContainer['teamService'],
): TeamHandlerResponse => ({
  getAllTeams: () => {
    const task = teamService.getTeams() as TE.TaskEither<ServiceError, Team[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((teams) => [...teams]),
    );
  },

  getTeamById: (req: Request) => {
    const teamId = Number(req.params.id);
    if (isNaN(teamId) || teamId <= 0) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid team ID: must be a positive integer',
        }),
      );
    }

    return pipe(
      teamService.getTeam(teamId as TeamId) as TE.TaskEither<ServiceError, Team | null>,
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
  },
});
