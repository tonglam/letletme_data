import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { PlayerId } from '../../types/players.type';
import { TeamId } from '../../types/teams.type';
import { logApiError, logApiRequest } from '../../utils/logger.util';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const playerRouter = ({ playerService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getAllPlayers: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get all players');

    pipe(
      await playerService.getPlayers()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (players) => res.json(formatResponse(players)),
      ),
    );
  };

  const getPlayerById: RequestHandler = async (req, res) => {
    const playerId = Number(req.params.id) as PlayerId;
    logApiRequest(req as ApiRequest, 'Get player by ID', { playerId });

    pipe(
      await playerService.getPlayer(playerId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (player) => res.json(formatResponse(player)),
      ),
    );
  };

  const getPlayersByTeam: RequestHandler = async (req, res) => {
    const teamId = Number(req.params.teamId) as TeamId;
    logApiRequest(req as ApiRequest, 'Get players by team ID', { teamId });

    pipe(
      await playerService.getPlayersByTeam(teamId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (players) => res.json(formatResponse(players)),
      ),
    );
  };

  // Register routes
  router.get('/players/', getAllPlayers);
  router.get('/players/:id', getPlayerById);
  router.get('/players/team/:teamId', getPlayersByTeam);

  return router;
};
