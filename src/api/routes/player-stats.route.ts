import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { PlayerId } from '../../types/players.type';
import { TeamId } from '../../types/teams.type';
import { logApiError, logApiRequest } from '../../utils/logger.util';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const playerStatsRouter = ({ playerStatsService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getAllStats: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get all player stats for current event');

    pipe(
      await playerStatsService.getCurrentEventStats()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (stats) => res.json(formatResponse(stats)),
      ),
    );
  };

  const getPlayerStats: RequestHandler = async (req, res) => {
    const playerId = Number(req.params.id) as PlayerId;
    logApiRequest(req as ApiRequest, 'Get player stats', { playerId });

    pipe(
      await playerStatsService.getCurrentPlayerStats(playerId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (stats) => res.json(formatResponse(stats)),
      ),
    );
  };

  const getTeamStats: RequestHandler = async (req, res) => {
    const teamId = Number(req.params.teamId) as TeamId;
    logApiRequest(req as ApiRequest, 'Get team stats', { teamId });

    pipe(
      await playerStatsService.getCurrentTeamStats(teamId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (stats) => res.json(formatResponse(stats)),
      ),
    );
  };

  // Register routes
  router.get('/players/stats/', getAllStats);
  router.get('/players/stats/:id', getPlayerStats);
  router.get('/players/stats/team/:teamId', getTeamStats);

  return router;
};
