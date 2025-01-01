import express, { NextFunction, Request, Response } from 'express';
import { logger } from '../configs/app/app.config';

export const setupErrorHandler = (app: express.Application): void => {
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error({ err }, 'Internal Server Error');
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
    next();
  });
};
