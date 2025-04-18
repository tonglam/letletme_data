import express, { Application } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Server } from 'http';
import { APIError } from '../types/error.type';
import { createDependencies } from './dependencies';
import { createServer } from './server';
import { ApplicationServices, createApplicationServices } from './services';

export const setupApplication = (): TE.TaskEither<
  APIError,
  { app: Application; services: ApplicationServices }
> =>
  pipe(
    TE.Do,
    TE.bind('app', () => TE.right<APIError, Application>(express())),
    TE.bind('deps', () => createDependencies()),
    TE.bind('services', ({ deps }) =>
      TE.right<APIError, ApplicationServices>(createApplicationServices(deps)),
    ),
    TE.map(({ app, services }) => ({ app, services })),
  );

export const initializeApp = (): TE.TaskEither<APIError, Server> =>
  pipe(
    setupApplication(),
    TE.chain(({ app, services }) => createServer(app, services)),
  );
