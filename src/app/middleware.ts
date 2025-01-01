import express from 'express';
import expressPinoLogger from 'pino-http';
import { logger } from '../configs/app/app.config';

export const setupMiddleware = (app: express.Application): void => {
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(expressPinoLogger({ logger }));
};
