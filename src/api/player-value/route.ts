import { Router } from 'express';

import { createPlayerValueHandlers } from './handler';
import { PlayerValueService } from '../../services/player-value/types';
import { createHandler } from '../middlewares/core';

export const playerValueRouter = (playerValueService: PlayerValueService): Router => {
  const router = Router();
  const handlers = createPlayerValueHandlers(playerValueService);

  router.get('/sync', createHandler(handlers.syncPlayerValues));
  router.get('/date/:changeDate', createHandler(handlers.getPlayerValuesByChangeDate));
  router.get('/element/:element', createHandler(handlers.getPlayerValuesByElement));
  router.get('/team/:team', createHandler(handlers.getPlayerValuesByTeam));

  return router;
};
