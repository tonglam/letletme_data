import { Router } from 'express';
import type { ServiceContainer } from '../services/types';
import { eventRouter } from './routes/event.route';

export const createRouter = (services: ServiceContainer): Router => {
  const router = Router();

  router.use('/events', eventRouter(services));

  return router;
};

export default (services: ServiceContainer): Router => createRouter(services);
