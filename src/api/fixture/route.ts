import { Router } from 'express';
import { FixtureService } from 'services/fixture/types';

import { createFixtureHandlers } from './handler';
import { createHandler } from '../middlewares/core';

export const fixtureRouter = (fixtureService: FixtureService): Router => {
  const router = Router();
  const handlers = createFixtureHandlers(fixtureService);

  router.get('/', createHandler(handlers.getFixtures));
  router.get('/team/:id', createHandler(handlers.getFixturesByTeamId));
  router.get('/event/:id', createHandler(handlers.getFixturesByEventId));

  return router;
};
