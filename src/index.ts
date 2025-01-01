import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { Server } from 'http';
import pino from 'pino';
import expressPinoLogger from 'pino-http';
import { createRouter } from './apis';
import { createQueueConfig, QUEUE_NAMES } from './configs/queue/queue.config';
import { BootstrapApi } from './domains/bootstrap/operations';
import { createFPLClient } from './infrastructures/http/fpl/client';
import { FPLEndpoints } from './infrastructures/http/fpl/types';
import { closeRedisClient, createRedisClient } from './infrastructures/redis/client';
import { MetaJobData } from './queues/jobs/processors/meta.processor';
import { createQueueService } from './queues/services/queue.service';
import { WorkerService } from './queues/services/worker.service';
import { ServiceContainer } from './services';
import { createEventService } from './services/events';
import { BootStrapResponse } from './types/bootstrap.type';
import {
  createServiceError,
  QueueError,
  ServiceError,
  ServiceErrorCode,
} from './types/errors.type';

// Load environment variables
dotenv.config();

// Application constants
const APP_CONSTANTS = {
  PORT: process.env.PORT || '3000',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
} as const;

// Custom type for server with worker
interface ServerWithWorker extends Server {
  worker?: WorkerService<MetaJobData>;
}

// Initialize core dependencies
const logger = pino({ level: APP_CONSTANTS.LOG_LEVEL });
const prisma = new PrismaClient();
const fplClient = createFPLClient();

// Create FPL Bootstrap API adapter
const createBootstrapApiAdapter = (
  client: FPLEndpoints,
): BootstrapApi & {
  getBootstrapEvents: () => Promise<BootStrapResponse['events']>;
} => ({
  getBootstrapData: async () => {
    const result = await client.bootstrap.getBootstrapStatic();
    if (result._tag === 'Left') {
      throw result.left;
    }
    return result.right;
  },
  getBootstrapEvents: async () => {
    const result = await client.bootstrap.getBootstrapStatic();
    if (result._tag === 'Left') {
      throw result.left;
    }
    return result.right.events;
  },
});

// Create Express application
const app = express();

// Initialize services
const services: ServiceContainer = {
  eventService: createEventService(createBootstrapApiAdapter(fplClient)),
};

// Middleware setup
const setupMiddleware = (application: express.Application): void => {
  application.use(express.json());
  application.use(express.urlencoded({ extended: true }));
  application.use(expressPinoLogger({ logger }));
};

// Error handling middleware
const setupErrorHandler = (application: express.Application): void => {
  application.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error({ err }, 'Internal Server Error');
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
    next();
  });
};

// Routes setup
const setupRoutes = (application: express.Application): void => {
  // Health check route
  application.get('/', (_req: Request, res: Response) => {
    res.send('Hello, Let let me data!');
  });

  // API routes
  application.use('/api', createRouter(services));
};

// Create services
const metaService = {
  sync: () =>
    TE.tryCatch(
      async () => {
        // Implement your sync logic here
        logger.info('Meta sync started');
      },
      (error) => error as Error,
    ),
  cleanup: () =>
    TE.tryCatch(
      async () => {
        // Implement your cleanup logic here
        logger.info('Meta cleanup started');
      },
      (error) => error as Error,
    ),
};

// Initialize application
const initializeApplication = (port: number): TE.TaskEither<ServiceError, ServerWithWorker> =>
  pipe(
    TE.Do,
    TE.bind('redis', () =>
      pipe(
        createRedisClient(),
        TE.mapLeft((error) =>
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: 'Failed to initialize Redis',
            cause: error,
          }),
        ),
      ),
    ),
    TE.bind('queueService', () =>
      pipe(
        createQueueService(createQueueConfig(QUEUE_NAMES.META), metaService),
        TE.mapLeft((error: QueueError) =>
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: error.message,
            cause: error.cause,
          }),
        ),
      ),
    ),
    TE.chain((deps) =>
      TE.tryCatch(
        async () => {
          // Setup application
          setupMiddleware(app);
          setupRoutes(app);
          setupErrorHandler(app);

          // Start queue worker
          await deps.queueService.worker.start()();
          logger.info('Queue worker started successfully');

          // Start server
          return new Promise<ServerWithWorker>((resolve, reject) => {
            const server = app.listen(port, () => {
              logger.info({ port }, 'Server started successfully');
              const serverWithWorker = server as ServerWithWorker;
              serverWithWorker.worker = deps.queueService.worker;
              resolve(serverWithWorker);
            });

            server.on('error', (error) => {
              logger.error({ error }, 'Server failed to start');
              reject(error);
            });
          });
        },
        (error) =>
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: 'Failed to initialize application',
            cause: error as Error,
          }),
      ),
    ),
  );

// Update shutdown to include Redis cleanup
const shutdownApplication = (server?: ServerWithWorker): TE.TaskEither<ServiceError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        if (server?.worker) {
          await server.worker.stop()();
          logger.info('Queue worker stopped successfully');
        }

        if (server) {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }
        await closeRedisClient();
        await prisma.$disconnect();
        logger.info('Application shutdown completed');
      },
      (error) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to shutdown application',
          cause: error as Error,
        }),
    ),
  );

// Server start function
const startServer = async (customPort?: number): Promise<ServerWithWorker> => {
  const serverPort = customPort || parseInt(APP_CONSTANTS.PORT, 10);
  const result = await pipe(
    initializeApplication(serverPort),
    TE.fold(
      (error) => {
        logger.error({ error }, 'Application startup failed');
        return T.of(Promise.reject(error));
      },
      (server) => T.of(Promise.resolve(server)),
    ),
  )();
  return result;
};

// Server stop function
const stopServer = async (server?: Server): Promise<void> => {
  return pipe(
    shutdownApplication(server),
    TE.fold(
      (error) => {
        logger.error({ error }, 'Application shutdown failed');
        return T.of(Promise.reject(error));
      },
      () => T.of(undefined),
    ),
  )();
};

export { app, logger, prisma, startServer, stopServer };
