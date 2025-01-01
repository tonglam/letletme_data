import express from 'express';
import { setupErrorHandler, setupMiddleware, setupRoutes } from '.';
import { ServiceContainer } from '../services';

export const createServer = (services: ServiceContainer) => {
  const app = express();

  // Setup application
  setupMiddleware(app);
  setupRoutes(app, services);
  setupErrorHandler(app);

  return app;
};
