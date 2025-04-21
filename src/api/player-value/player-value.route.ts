import { Router } from 'express';

import { createPlayerValueHandlers } from './player-value.handler';
import { PlayerValueService } from '../../services/player-value/types';
import { createHandler } from '../middlewares/core';

export const playerValueRouter = (playerValueService: PlayerValueService): Router => {
  const router = Router();
  const handlers = createPlayerValueHandlers(playerValueService);

  router.get('/sync', createHandler(handlers.syncPlayerValues));
  router.get('/:changeDate', createHandler(handlers.getPlayerValuesByChangeDate));
  router.get('/:element', createHandler(handlers.getPlayerValuesByElement));
  router.get('/:team', createHandler(handlers.getPlayerValuesByTeam));

  return router;
};
