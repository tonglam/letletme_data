import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';

import { createPlayerValueHandlers } from '../handlers/player-value.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const PlayerValueIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const playerValueRouter = ({ playerValueService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerValueHandlers(playerValueService);

  router.get('/', createHandler(handlers.getAllPlayerValues));
  router.get(
    '/:id',
    validateRequest(PlayerValueIdParams),
    createHandler(handlers.getPlayerValueById),
  );

  return router;
};
