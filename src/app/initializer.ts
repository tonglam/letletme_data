import { Application } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createEventRepository } from '../repositories/event/repository';
import { createPhaseRepository } from '../repositories/phase/repository';
// import { createTeamRepository } from '../repositories/team/repository';
import { createFplBootstrapDataService } from '../data/fpl/bootstrap.data';
import { createEventCache } from '../domains/event/cache';
import { createPhaseCache } from '../domains/phase/cache';
import { prisma } from '../infrastructures/db/prisma';
import { HTTPClient } from '../infrastructures/http/client';
import { getFplApiLogger } from '../infrastructures/logger';
import { registry, ServiceDependencies } from '../services/registry';
import {
  APIError,
  APIErrorCode,
  createAPIError,
  createQueueError,
  QueueError,
  QueueErrorCode,
} from '../types/error.type';
import { createServer } from './server';

// Create logger instance
const logger = getFplApiLogger();

// Create repositories
const eventRepository = createEventRepository(prisma);
const phaseRepository = createPhaseRepository(prisma);
// const teamRepository = createTeamRepository(prisma); // Uncomment when repository is implemented

// Create caches
const eventCache = createEventCache(eventRepository);
const phaseCache = createPhaseCache(phaseRepository);

// Define queue service creator function with proper parameter
const createEventMetaQueueService = (eventMetaService: EventMetaService) =>
  TE.right({
    addJob: (jobData: any) => () => Promise.resolve(),
  });

// Define job data creator with proper parameters
const createMetaJobData = (operation: string, metaType: string) => ({
  operation,
  metaType,
});

// Temporary type for EventMetaService until properly defined
interface EventMetaService {
  syncMeta: () => TE.TaskEither<Error, void>;
  syncEvents: () => TE.TaskEither<Error, void>;
}

// Ensure QueueError extends Error by implementing name and message properties
// This is needed as QueueError doesn't extend the Error interface in error.type.ts
const ensureErrorProperties = (queueError: QueueError): Error => {
  return {
    ...queueError,
    name: `QueueError:${queueError.code}`,
    message: `Error in queue context '${queueError.context}': ${queueError.error.message}`,
  } as Error;
};

// Create a simple HTTP client for testing
const createTestHTTPClient = (): HTTPClient => {
  // Create a basic HTTPClient implementation
  return {
    get: <T>() =>
      TE.left<APIError, T>(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    post: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    put: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    patch: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    delete: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    head: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    options: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    trace: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    connect: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
    request: () =>
      TE.left(
        createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: 'Method not implemented in test client',
        }),
      ),
  };
};

export const initializeApp = (): TE.TaskEither<APIError, void> =>
  pipe(
    TE.Do,
    TE.bind('app', () => TE.right<APIError, Application>(require('express')())),
    TE.bind('fplClient', () => TE.right(createTestHTTPClient())),
    TE.bind('services', ({ fplClient }) => {
      const fplDataService = createFplBootstrapDataService(fplClient, logger);
      const deps: ServiceDependencies = {
        fplDataService,
        eventRepository,
        eventCache,
        phaseRepository,
        phaseCache,
        // teamRepository, // Uncomment when repository is implemented
        // playerRepository, // Add when implemented
        // playerStatRepository, // Add when implemented
        // playerValueRepository, // Add when implemented
      };
      // Check that all required keys in ServiceDependencies are present in deps
      return registry.createAll(deps);
    }),
    // Initialize event meta queue service
    TE.bind('queueService', ({ services }) =>
      pipe(
        TE.tryCatch(
          async () => {
            const eventService = services.eventService;
            const eventMetaService: EventMetaService = {
              syncMeta: () => TE.right(undefined),
              syncEvents: () =>
                pipe(
                  eventService.syncEventsFromApi(),
                  TE.map(() => undefined),
                  TE.mapLeft((error) => {
                    // Create QueueError and ensure it has Error properties
                    const queueErr = createQueueError(
                      QueueErrorCode.PROCESSING_ERROR,
                      'meta',
                      error as Error,
                    );
                    return ensureErrorProperties(queueErr);
                  }),
                ),
            };

            const queueResult = await createEventMetaQueueService(eventMetaService)();
            if (queueResult._tag === 'Left') {
              throw queueResult.left;
            }

            // Schedule the event sync job
            await queueResult.right.addJob(createMetaJobData('SYNC', 'EVENTS'))();
            return queueResult.right;
          },
          (error) =>
            createAPIError({
              code: APIErrorCode.INTERNAL_SERVER_ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
              cause: error instanceof Error ? error : undefined,
            }),
        ),
      ),
    ),
    TE.chain(({ app, services }) =>
      TE.tryCatch(
        () => {
          createServer(app, services);
          logger.info('Server initialized successfully');
          return Promise.resolve();
        },
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    ),
  );
