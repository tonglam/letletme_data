import { Router } from 'express';

import type { ApplicationServices } from '../app/services';
import { eventRouter } from './routes/event.route';
import { phaseRouter } from './routes/phase.route';
import { playerStatRouter } from './routes/player-stat.route';
import { playerValueRouter } from './routes/player-value.route';
import { playerRouter } from './routes/player.route';
import { teamRouter } from './routes/team.route';

export const createRouter = (services: ApplicationServices): Router => {
  const router = Router();

  router.use('/events', eventRouter(services.eventService));
  router.use('/phases', phaseRouter(services.phaseService));
  router.use('/players', playerRouter(services.playerService));
  router.use('/player-stats', playerStatRouter(services.playerStatService));
  router.use('/player-values', playerValueRouter(services.playerValueService));
  router.use('/teams', teamRouter(services.teamService));

  return router;
};

export default (services: ApplicationServices): Router => createRouter(services);
