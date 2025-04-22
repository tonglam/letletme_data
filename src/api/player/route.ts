import { Router } from 'express';

import { createPlayerHandlers } from './handler';
import { PlayerService } from '../../services/player/types';
import { createHandler } from '../middlewares/core';

export const playerRouter = (playerService: PlayerService): Router => {
  const router = Router();
  const handlers = createPlayerHandlers(playerService);

  router.get('/', createHandler(handlers.getAllPlayers));
  router.post('/sync', createHandler(handlers.syncPlayers));
  router.get('/:id', createHandler(handlers.getPlayerByElement));

  return router;
};
