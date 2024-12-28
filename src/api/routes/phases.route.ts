import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { PhaseId } from '../../types/phases.type';
import { logApiError, logApiRequest } from '../../utils/logger.util';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const phaseRouter = ({ phaseService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getAllPhases: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get all phases');

    pipe(
      await phaseService.getPhases()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (phases) => res.json(formatResponse(phases)),
      ),
    );
  };

  const getPhaseById: RequestHandler = async (req, res) => {
    const phaseId = Number(req.params.id) as PhaseId;
    logApiRequest(req as ApiRequest, 'Get phase by ID', { phaseId });

    pipe(
      await phaseService.getPhase(phaseId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (phase) => res.json(formatResponse(phase)),
      ),
    );
  };

  // Register routes
  router.get('/phases/', getAllPhases);
  router.get('/phases/:id', getPhaseById);

  return router;
};
