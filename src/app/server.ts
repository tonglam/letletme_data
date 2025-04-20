import { Server } from 'http';

import cors from 'cors';
import express, { Application, Router } from 'express';
import * as TE from 'fp-ts/TaskEither';

import { setupRoutes } from './routes';
import { ApplicationServices } from './services';
import { handleError } from '../api/middlewares/core';
import { AppConfig } from '../configs/app/app.config';
import { getApiLogger } from '../infrastructures/logger';
import { APIError, APIErrorCode, createAPIError } from '../types/error.type';

const logger = getApiLogger();

export const createServer = (
  app: Application,
  services: ApplicationServices,
): TE.TaskEither<APIError, Server> =>
  TE.tryCatch(
    async () => {
      // Core Middleware
      app.use(cors());
      app.use(express.json());

      // Setup API Routes
      const apiRouter: Router = setupRoutes(services);
      const basePath = '/api/v1';
      app.use(basePath, apiRouter);

      // Pass handleError directly, now that it accepts 4 args
      app.use(handleError);

      // Start the server
      const port = AppConfig.port;
      const server = app.listen(port, () => {
        logger.info(`Server listening on port ${port} at ${basePath}`);
      });

      // Handle server errors (e.g., port already in use)
      server.on('error', (error) => {
        logger.fatal({ error }, 'Server failed to start');
        throw error;
      });

      return server;
    },
    (error) =>
      createAPIError({
        code: APIErrorCode.INTERNAL_SERVER_ERROR,
        message: error instanceof Error ? error.message : 'Failed to create or start server',
        cause: error instanceof Error ? error : undefined,
      }),
  );
