import { Router } from 'express';
import { PlayerStatService } from '../../services/player-stat/types';

import { createPlayerStatHandlers } from '../handlers/player-stat.handler';
import { createHandler } from '../middlewares/core';

export const playerStatRouter = (playerStatService: PlayerStatService): Router => {
  const router = Router();
  const handlers = createPlayerStatHandlers(playerStatService);

  router.get('/', createHandler(handlers.getAllPlayerStats));
  router.get('/:id', createHandler(handlers.getPlayerStatById));

  return router;
};
