import { Router } from 'express';

import { PhaseService } from '../../services/phase/types';
import { createPhaseHandlers } from '../handlers/phase.handler';
import { createHandler } from '../middlewares/core';

export const phaseRouter = (phaseService: PhaseService): Router => {
  const router = Router();
  const handlers = createPhaseHandlers(phaseService);

  router.get('/', createHandler(handlers.getAllPhases));
  router.get('/:id', createHandler(handlers.getPhaseById));

  return router;
};
