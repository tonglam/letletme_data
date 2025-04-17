import { Server } from 'http';

import { Application } from 'express';

import { setupErrorHandler } from './error-handler';
import { setupMiddleware } from './middleware';
import { setupRoutes } from './routes';
import { ServiceContainer } from '../services/types';

export const createServer = (app: Application, services: ServiceContainer): Server => {
  setupMiddleware(app);
  app.use(setupRoutes(services));
  setupErrorHandler(app);

  return app.listen(process.env.PORT || 3000);
};
