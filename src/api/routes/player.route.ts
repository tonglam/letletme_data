import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';
import { createPlayerHandlers } from '../handlers/player.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const PlayerIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const playerRouter = ({ playerService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerHandlers(playerService);

  router.get('/', createHandler(handlers.getAllPlayers));
  router.get('/:id', validateRequest(PlayerIdParams), createHandler(handlers.getPlayerById));

  return router;
};
