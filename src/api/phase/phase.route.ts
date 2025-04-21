import { Router } from 'express';
import { createPhaseHandlers } from 'src/api/phase/phase.handler';

import { PhaseService } from '../../services/phase/types';
import { createHandler } from '../middlewares/core';

export const phaseRouter = (phaseService: PhaseService): Router => {
  const router = Router();
  const handlers = createPhaseHandlers(phaseService);

  router.get('/', createHandler(handlers.getAllPhases));
  router.get('/sync', createHandler(handlers.syncPhases));
  router.get('/:id', createHandler(handlers.getPhaseById));

  return router;
};
