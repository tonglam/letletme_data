import { Router } from 'express';
import { PlayerValueService } from '../../services/player-value/types';

import { createPlayerValueHandlers } from '../handlers/player-value.handler';
import { createHandler } from '../middlewares/core';

export const playerValueRouter = (playerValueService: PlayerValueService): Router => {
  const router = Router();
  const handlers = createPlayerValueHandlers(playerValueService);

  router.get('/', createHandler(handlers.getAllPlayerValues));
  router.get('/:id', createHandler(handlers.getPlayerValueById));

  return router;
};
