import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { TeamId } from '../../types/teams.type';
import { logApiError, logApiRequest } from '../../utils/logger';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const teamRouter = ({ teamService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getAllTeams: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get all teams');

    pipe(
      await teamService.getTeams()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (teams) => res.json(formatResponse(teams)),
      ),
    );
  };

  const getTeamById: RequestHandler = async (req, res) => {
    const teamId = Number(req.params.id) as TeamId;
    logApiRequest(req as ApiRequest, 'Get team by ID', { teamId });

    pipe(
      await teamService.getTeam(teamId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (team) => res.json(formatResponse(team)),
      ),
    );
  };

  const getTeamByCode: RequestHandler = async (req, res) => {
    const code = Number(req.params.code);
    logApiRequest(req as ApiRequest, 'Get team by code', { code });

    pipe(
      await teamService.getTeamByCode(code)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (team) => res.json(formatResponse(team)),
      ),
    );
  };

  // Register routes
  router.get('/teams/', getAllTeams);
  router.get('/teams/code/:code', getTeamByCode);
  router.get('/teams/:id', getTeamById);

  return router;
};
