import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { PlayerId } from '../../types/players.type';
import { TeamId } from '../../types/teams.type';
import { logApiError, logApiRequest } from '../../utils/logger';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const playerValuesRouter = ({ playerValuesService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getLatestValues: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get latest player values');

    pipe(
      await playerValuesService.getLatestValues()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (values) => res.json(formatResponse(values)),
      ),
    );
  };

  const getValuesByDate: RequestHandler = async (req, res) => {
    const date = req.params.date;
    logApiRequest(req as ApiRequest, 'Get player values by date', { date });

    pipe(
      await playerValuesService.getValuesByDate(date)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (values) => res.json(formatResponse(values)),
      ),
    );
  };

  const getPlayerValues: RequestHandler = async (req, res) => {
    const playerId = Number(req.params.id) as PlayerId;
    logApiRequest(req as ApiRequest, 'Get player values history', { playerId });

    pipe(
      await playerValuesService.getPlayerValues(playerId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (values) => res.json(formatResponse(values)),
      ),
    );
  };

  const getTeamLatestValues: RequestHandler = async (req, res) => {
    const teamId = Number(req.params.teamId) as TeamId;
    logApiRequest(req as ApiRequest, 'Get team latest values', { teamId });

    pipe(
      await playerValuesService.getTeamLatestValues(teamId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (values) => res.json(formatResponse(values)),
      ),
    );
  };

  // Register routes
  router.get('/players/values/', getLatestValues);
  router.get('/players/values/date/:date', getValuesByDate);
  router.get('/players/values/:id', getPlayerValues);
  router.get('/players/values/team/:teamId', getTeamLatestValues);

  return router;
};
