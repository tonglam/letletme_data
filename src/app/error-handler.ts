import { Application, Request, Response } from 'express';
import { logger } from '../config/app/app.config';

export const setupErrorHandler = (app: Application): void => {
  app.use((err: Error, _req: Request, res: Response) => {
    logger.error({ err }, 'Error occurred');
    res.status(500).json({ error: 'Internal Server Error' });
  });
};
