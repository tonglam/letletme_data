import { Router } from 'express';

import { createPlayerStatHandlers } from './player-stat.handler';
import { PlayerStatService } from '../../services/player-stat/types';
import { createHandler } from '../middlewares/core';

export const playerStatRouter = (playerStatService: PlayerStatService): Router => {
  const router = Router();
  const handlers = createPlayerStatHandlers(playerStatService);

  router.get('/', createHandler(handlers.getPlayerStats));
  router.get('/sync', createHandler(handlers.syncPlayerStats));
  router.get('/:elementType', createHandler(handlers.getPlayerStatsByElementType));
  router.get('/:team', createHandler(handlers.getPlayerStatsByTeam));
  router.get('/:element', createHandler(handlers.getPlayerStat));

  return router;
};
