import { Router } from 'express';
import { TeamService } from '../../services/team/types';

import { createTeamHandlers } from '../handlers/team.handler';
import { createHandler } from '../middlewares/core';

export const teamRouter = (teamService: TeamService): Router => {
  const router = Router();
  const handlers = createTeamHandlers(teamService);

  router.get('/', createHandler(handlers.getAllTeams));
  router.get('/:id', createHandler(handlers.getTeamById));

  return router;
};
