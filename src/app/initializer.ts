import { Application } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createEventRepository } from '../domain/event/repository';
import { createPhaseRepository } from '../domain/phase/repository';
import { createTeamRepository } from '../domain/team/repository';
import { prisma } from '../infrastructure/db/prisma';
import { createFPLClient } from '../infrastructure/http/fpl/client';
import { FPLEndpoints } from '../infrastructure/http/fpl/types';
import { createEventMetaQueueService } from '../queue/meta/event.meta.queue';
import { createMetaJobData } from '../queue/meta/meta.queue';
import { ServiceKey } from '../service';
import { registry, ServiceDependencies } from '../service/registry';
import { createBootstrapApiDependencies } from '../service/utils';
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
const eventRepository = createEventRepository(prisma);
const phaseRepository = createPhaseRepository(prisma);
const teamRepository = createTeamRepository(prisma);

export const initializeApp = (): TE.TaskEither<APIError, void> =>
  pipe(
    TE.Do,
    TE.bind('app', () => TE.right<APIError, Application>(express())),
    TE.bind('fplClient', () => TE.right<APIError, FPLEndpoints>(createFPLClient())),
    TE.bind('services', ({ fplClient }) => {
      const deps: ServiceDependencies = {
        bootstrapApi: createBootstrapApiDependencies(fplClient),
        eventRepository,
        phaseRepository,
        teamRepository,
      };
      return registry.createAll(deps);
    }),
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
