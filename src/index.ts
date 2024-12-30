import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { Server } from 'http';
import pino from 'pino';
import expressPinoLogger from 'pino-http';
import { createFPLClient } from './infrastructures/http/fpl';
import { WorkerAdapter } from './infrastructures/queue/types';
import router from ;

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const fplClient = createFPLClient();

// Custom type for server with worker
interface ServerWithWorker extends Server {
  worker?: WorkerAdapter;
}

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(expressPinoLogger({ logger }));

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err }, 'Internal Server Error');
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
  next();
});

// Routes
app.get('/', (req: Request, res: Response) => {
  res.send('Hello, Let let me data!');
});

// Register routes
app.use('/api', router);


const startServer = async (customPort?: number): Promise<ServerWithWorker> => {
  const serverPort = customPort || port;
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
