import { Router } from 'express';
import { PlayerService } from '../../services/player/types';

import { createPlayerHandlers } from '../handlers/player.handler';
import { createHandler } from '../middlewares/core';

export const playerRouter = (playerService: PlayerService): Router => {
  const router = Router();
  const handlers = createPlayerHandlers(playerService);

  router.get('/', createHandler(handlers.getAllPlayers));
  router.get('/:id', createHandler(handlers.getPlayerById));

  return router;
};
