import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { Server } from 'http';
import { logger } from '../configs/app/app.config';
import { createQueueConfig, QUEUE_NAMES } from '../configs/queue/queue.config';
import { createBootstrapApiAdapter } from '../domains/bootstrap/adapter';
import { createFPLClient } from '../infrastructures/http/fpl/client';
import { QueueService } from '../infrastructures/queue/core/queue.service';
import { closeRedisClient, createRedisClient } from '../infrastructures/redis/client';
import { initializeMetaQueue } from '../queues/meta/core/meta.service';
import { MetaJobData } from '../queues/types';
import { ServiceContainer } from '../services';
import { createEventService } from '../services/events';
import { eventWorkflows } from '../services/events/workflow';
import {
  createQueueError,
  createServiceError,
  QueueErrorCode,
  ServiceError,
  ServiceErrorCode,
} from '../types/errors.type';
import { createServer } from './server';

// Custom type for server with queue service
interface ServerWithQueue extends Server {
  queueService?: QueueService<MetaJobData>;
}

// Initialize core dependencies
const prisma = new PrismaClient();
const fplClient = createFPLClient();
const bootstrapApi = createBootstrapApiAdapter(fplClient);

// Initialize application
export const initializeApplication = (port: number): TE.TaskEither<ServiceError, ServerWithQueue> =>
  pipe(
    TE.Do,
    // 1. Initialize Redis
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

    // 2. Create API services
    TE.bind('services', () =>
      TE.right({
        eventService: createEventService(bootstrapApi),
      } as ServiceContainer),
    ),

    // 3. Create job services
    TE.bind('metaJobService', () =>
      pipe(
        initializeMetaQueue(createQueueConfig(QUEUE_NAMES.META), {
          eventsService: pipe(createEventService(bootstrapApi), eventWorkflows, (workflows) => ({
            syncEvents: () =>
              pipe(
                workflows.syncEvents(),
                TE.mapLeft((error) =>
                  createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta', error),
                ),
                TE.map(() => undefined),
              ),
            startWorker: () => TE.right(undefined),
            stopWorker: () => TE.right(undefined),
          })),
          cleanup: async () => {
            logger.info('Meta cleanup started');
            // Implement cleanup logic
          },
        }),
        TE.mapLeft((error) =>
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: error.message,
            cause: error.cause,
          }),
        ),
      ),
    ),

    // 4. Start application
    TE.chain((deps) =>
      TE.tryCatch(
        async () => {
          const app = createServer(deps.services);

          // Start queue worker
          await deps.metaJobService.startWorker()();
          logger.info('Queue worker started successfully');

          // Start server
          return new Promise<ServerWithQueue>((resolve, reject) => {
            const server = app.listen(port, () => {
              logger.info({ port }, 'Server started successfully');
              const serverWithQueue = server as ServerWithQueue;
              serverWithQueue.queueService = deps.metaJobService.queueService;
              resolve(serverWithQueue);
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

// Shutdown application
export const shutdownApplication = (server?: ServerWithQueue): TE.TaskEither<ServiceError, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        if (server?.queueService) {
          await server.queueService.stopWorker()();
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
