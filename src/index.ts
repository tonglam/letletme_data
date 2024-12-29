import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import expressPinoLogger from 'pino-http';
import router from './api/routes';
import { META_QUEUE_CONFIG } from './config/queue/queue.config';
import { getGlobalCacheModule } from './infrastructure/cache/cache';
import { createFPLClient } from './infrastructure/http/fpl';
import { QUEUE_JOB_TYPES } from './infrastructure/queue';
import { createMetaWorkerService } from './jobs/meta/base/meta.worker';
import { eventJobService } from './jobs/meta/events.job';
import { phaseJobService } from './jobs/meta/phases.job';
import { teamJobService } from './jobs/meta/teams.job';
import { initializeServices } from './services';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Initialize worker
const worker = createMetaWorkerService(
  {
    process: (job) => {
      switch (job.data.type) {
        case QUEUE_JOB_TYPES.EVENTS:
          return eventJobService.processEventsJob(job);
        case QUEUE_JOB_TYPES.TEAMS:
          return teamJobService.processTeamsJob(job);
        case QUEUE_JOB_TYPES.PHASES:
          return phaseJobService.processPhasesJob(job);
        default:
          return TE.left(new Error(`Unknown job type: ${job.data.type}`));
      }
    },
    onCompleted: (job) => {
      logger.info({ jobId: job.id }, 'Job completed successfully');
    },
    onFailed: (job, error) => {
      logger.error({ jobId: job.id, error }, 'Job failed');
    },
    onError: (error) => {
      logger.error({ error }, 'Worker error');
    },
  },
  META_QUEUE_CONFIG,
);

// Start worker
worker.start()();

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

// Initialize services
const fplClient = createFPLClient();

// Initialize cache and services
const startServer = async (customPort?: number) => {
  const serverPort = customPort || port;
  try {
    // Initialize cache module
    await pipe(
      getGlobalCacheModule().initialize(),
      TE.fold(
        (error) => {
          logger.error({ error }, 'Failed to initialize cache module');
          throw error;
        },
        () => T.of(undefined),
      ),
    )();

    // Initialize services after cache is ready
    initializeServices({
      getBootstrapData: async () => {
        const result = await fplClient.bootstrap.getBootstrapStatic();
        if (E.isLeft(result)) throw new Error(result.left.message);
        return result.right;
      },
    });

    // Connect to the database
    await prisma.$connect();
    logger.info('Connected to database successfully');

    const server = app.listen(serverPort, () => {
      logger.info(`Server is listening at http://localhost:${serverPort}`);
    });

    server.on('error', (error: NodeJS.ErrnoException) => {
      logger.error({ error }, 'Server failed to start');
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${serverPort} is already in use`);
      }
    });

    return server;
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    throw error;
  }
};

// Graceful shutdown
const stopServer = async (server?: ReturnType<typeof app.listen>) => {
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed');
    }

    // Shutdown cache
    await pipe(
      getGlobalCacheModule().shutdown(),
      TE.fold(
        (error) => T.of(Promise.reject(error)),
        () => T.of(undefined),
      ),
    )();

    // Disconnect from database
    await prisma.$disconnect();
    logger.info('Disconnected from database');
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    throw error;
  }
};

export { app, logger, prisma, startServer, stopServer };
