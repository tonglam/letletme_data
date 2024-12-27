import { Router } from 'express';
import { getServices } from '../../services';
import { eventRouter } from './events.route';
import { jobRouter } from './jobs.routes';
import { phaseRouter } from './phases.route';
import { playerStatsRouter } from './player-stats.route';
import { playerRouter } from './players.route';
import { teamRouter } from './teams.route';

// Create base router factory
export const createRouter = (): Router => {
  // Get services
  const services = getServices();

  // Create base router
  const router = Router();

  // Mount domain routes with services
  router.use('/events', eventRouter(services));
  router.use('/phases', phaseRouter(services));
  router.use('/players', playerRouter(services));
  router.use('/player-stats', playerStatsRouter(services));
  router.use('/teams', teamRouter(services));
  router.use('/monitor', jobRouter(services));

  return router;
};

// Export default router instance
export default createRouter();
