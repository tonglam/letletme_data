import { Request, Response, Router } from 'express';

import { createRouter } from '../api';
import { ServiceContainer } from '../services/types';

export const setupRoutes = (services: ServiceContainer): Router => {
  const router = Router();

  router.get('/health', (_: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.use('/api', createRouter(services));

  return router;
};
