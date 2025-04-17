import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';

import { createPlayerStatHandlers } from '../handlers/player-stat.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const PlayerStatIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const playerStatRouter = ({ playerStatService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerStatHandlers(playerStatService);

  router.get('/', createHandler(handlers.getAllPlayerStats));
  router.get(
    '/:id',
    validateRequest(PlayerStatIdParams),
    createHandler(handlers.getPlayerStatById),
  );

  return router;
};
