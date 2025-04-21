import { Router } from 'express';

import { eventRouter } from './event/event.route';
import { phaseRouter } from './phase/phase.route';
import { playerStatRouter } from './player-stat/player-stat.route';
import { playerValueRouter } from './player-value/player-value.route';
import { playerRouter } from './player/player.route';
import { teamRouter } from './team/team.route';

import type { ApplicationServices } from '../app/services';

export const createRouter = (services: ApplicationServices): Router => {
  const router = Router();

  router.use('/events', eventRouter(services.eventService));
  router.use('/phases', phaseRouter(services.phaseService));
  router.use('/teams', teamRouter(services.teamService));
  router.use('/players', playerRouter(services.playerService));
  router.use('/player-stats', playerStatRouter(services.playerStatService));
  router.use('/player-values', playerValueRouter(services.playerValueService));

  return router;
};

export default (services: ApplicationServices): Router => createRouter(services);
