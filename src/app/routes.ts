import express, { Request, Response } from 'express';
import { createRouter } from '../apis';
import { ServiceContainer } from '../services';

export const setupRoutes = (app: express.Application, services: ServiceContainer): void => {
  // Health check route
  app.get('/', (_req: Request, res: Response) => {
    res.send('Hello, Let let me data!');
  });

  // API routes
  app.use('/api', createRouter(services));
};
