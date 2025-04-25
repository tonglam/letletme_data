import { Router } from 'express';

import { createTeamHandlers } from './handler';
import { TeamService } from '../../services/team/types';
import { createHandler } from '../middlewares/core';

export const teamRouter = (teamService: TeamService): Router => {
  const router = Router();
  const handlers = createTeamHandlers(teamService);

  router.get('/', createHandler(handlers.getAllTeams));
  router.get('/:id', createHandler(handlers.getTeamById));

  return router;
};
