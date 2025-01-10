// Team Handlers Module
//
// Provides handlers for team-related API endpoints using functional programming
// patterns with fp-ts. Handles team retrieval operations including getting all teams
// and specific teams by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { toAPIError } from 'src/utils/error.util';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { Team, TeamId } from '../../types/team.type';
import { TeamHandlerResponse } from '../types';

// Creates team handlers with dependency injection
export const createTeamHandlers = (
  teamService: ServiceContainer[typeof ServiceKey.TEAM],
): TeamHandlerResponse => ({
  // Retrieves all teams
  getAllTeams: () => {
    const task = teamService.getTeams() as unknown as TE.TaskEither<ServiceError, Team[]>;
    return pipe(
      task,
      TE.mapLeft(toAPIError),
      TE.map((teams) => teams.slice()),
    );
  },

  // Retrieves a specific team by ID
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

    const task = teamService.getTeam(teamId as TeamId) as unknown as TE.TaskEither<
      ServiceError,
      Team | null
    >;
    return pipe(
      task,
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
