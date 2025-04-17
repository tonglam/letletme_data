import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';

import { createTeamHandlers } from '../handlers/team.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const TeamIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const teamRouter = ({ teamService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createTeamHandlers(teamService);

  router.get('/', createHandler(handlers.getAllTeams));
  router.get('/:id', validateRequest(TeamIdParams), createHandler(handlers.getTeamById));

  return router;
};
