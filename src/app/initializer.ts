import { Application } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createFPLClient } from '../infrastructure/http/fpl/client';
import { FPLEndpoints } from '../infrastructure/http/fpl/types';
import { ServiceContainer, ServiceKey } from '../service';
import { createEventService } from '../service/event';
import { APIError, APIErrorCode, createAPIError } from '../types/errors.type';
import { createServer } from './server';

const express = require('express');

export const initializeApp = (): TE.TaskEither<APIError, void> =>
  pipe(
    TE.Do,
    TE.bind('app', () => TE.right<APIError, Application>(express())),
    TE.bind('fplClient', () => TE.right<APIError, FPLEndpoints>(createFPLClient())),
    TE.bind('services', ({ fplClient }) =>
      TE.right<APIError, ServiceContainer>({
        [ServiceKey.EVENT]: createEventService({
          getBootstrapData: async () => {
            const result = await fplClient.bootstrap.getBootstrapStatic();
            if ('left' in result) {
              throw result.left;
            }
            return result.right;
          },
          getBootstrapEvents: async () => {
            const result = await fplClient.bootstrap.getBootstrapStatic();
            if ('left' in result) {
              throw result.left;
            }
            return result.right.events;
          },
        }),
      }),
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
