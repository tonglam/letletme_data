import { Application, json, urlencoded } from 'express';
import { Logger } from 'pino';
import expressPinoLogger from 'pino-http';
import { logger } from '../config/app/app.config';

export const setupMiddleware = (app: Application): void => {
  app.use(json());
  app.use(urlencoded({ extended: true }));
  app.use(
    expressPinoLogger({
      logger: logger as unknown as Logger<string>,
    }),
  );
};
