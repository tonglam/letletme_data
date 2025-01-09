import { Application } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { eventRepository } from '../domain/event/repository';
import { createPhaseRepository } from '../domain/phase/repository';
import { prisma } from '../infrastructure/db/prisma';
import { createFPLClient } from '../infrastructure/http/fpl/client';
import { FPLEndpoints } from '../infrastructure/http/fpl/types';
import { createEventMetaQueueService } from '../queue/meta/event.meta.queue';
import { createMetaJobData } from '../queue/meta/meta.queue';
import { ServiceContainer, ServiceKey } from '../service';
import { createEventService } from '../service/event';
import { createPhaseService } from '../service/phase';
import {
  APIError,
  APIErrorCode,
  createAPIError,
  createQueueError,
  QueueErrorCode,
} from '../types/error.type';
import { EventMetaService } from '../types/job.type';
import { createServer } from './server';

const express = require('express');

// Create repositories
const phaseRepository = createPhaseRepository(prisma);

export const initializeApp = (): TE.TaskEither<APIError, void> =>
  pipe(
    TE.Do,
    TE.bind('app', () => TE.right<APIError, Application>(express())),
    TE.bind('fplClient', () => TE.right<APIError, FPLEndpoints>(createFPLClient())),
    TE.bind('services', ({ fplClient }) =>
      TE.right<APIError, ServiceContainer>({
        [ServiceKey.EVENT]: createEventService(
          {
            getBootstrapData: async () => {
              const result = await fplClient.bootstrap.getBootstrapStatic();
              if ('left' in result) {
                throw result.left;
              }
              return result.right;
            },
            getBootstrapEvents: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.events),
                ),
              ),
            getBootstrapPhases: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.phases),
                ),
              ),
            getBootstrapTeams: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.teams),
                ),
              ),
            getBootstrapElements: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.elements),
                ),
              ),
          },
          eventRepository,
        ),
        [ServiceKey.PHASE]: createPhaseService(
          {
            getBootstrapData: async () => {
              const result = await fplClient.bootstrap.getBootstrapStatic();
              if ('left' in result) {
                throw result.left;
              }
              return result.right;
            },
            getBootstrapEvents: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.events),
                ),
              ),
            getBootstrapPhases: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.phases),
                ),
              ),
            getBootstrapTeams: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.teams),
                ),
              ),
            getBootstrapElements: () =>
              pipe(
                TE.tryCatch(
                  () => fplClient.bootstrap.getBootstrapStatic(),
                  (error) =>
                    createAPIError({
                      code: APIErrorCode.INTERNAL_SERVER_ERROR,
                      message: error instanceof Error ? error.message : 'Unknown error',
                    }),
                ),
                TE.chain((result) =>
                  'left' in result ? TE.left(result.left) : TE.right(result.right.elements),
                ),
              ),
          },
          phaseRepository,
        ),
      }),
    ),
    // Initialize event meta queue service
    TE.bind('queueService', ({ services }) =>
      pipe(
        TE.tryCatch(
          async () => {
            const eventService = services[ServiceKey.EVENT];
            const eventMetaService: EventMetaService = {
              syncMeta: () => TE.right(undefined),
              syncEvents: () =>
                pipe(
                  eventService.syncEventsFromApi(),
                  TE.map(() => undefined),
                  TE.mapLeft((error) =>
                    createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', error as Error),
                  ),
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
            }),
        ),
      ),
    ),
    TE.chain(({ app, services }) =>
      TE.tryCatch(
        () => {
          createServer(app, services);
          return Promise.resolve();
        },
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      ),
    ),
  );
