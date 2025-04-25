import { Router } from 'express';

import { createPlayerStatHandlers } from './handler';
import { PlayerStatService } from '../../services/player-stat/types';
import { createHandler } from '../middlewares/core';

export const playerStatRouter = (playerStatService: PlayerStatService): Router => {
  const router = Router();
  const handlers = createPlayerStatHandlers(playerStatService);

  router.get('/', createHandler(handlers.getPlayerStats));
  router.get('/element/:element', createHandler(handlers.getPlayerStat));
  router.get('/element-type/:elementType', createHandler(handlers.getPlayerStatsByElementType));
  router.get('/team/:team', createHandler(handlers.getPlayerStatsByTeam));

  return router;
};
