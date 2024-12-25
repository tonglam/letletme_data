import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import * as TE from 'fp-ts/TaskEither';
import pino from 'pino';
import expressPinoLogger from 'pino-http';
import { eventRouter } from './domains/events';
import { monitorRouter } from './domains/monitor/routes';
import { phaseRouter } from './domains/phases';
import { teamRouter } from './domains/teams';
import { QUEUE_JOB_TYPES } from './infrastructure/queue';
import { META_QUEUE_CONFIG } from './infrastructure/queue/config/queue.config';
import { createMetaWorkerService } from './services/queue/meta/base/meta.worker';
import { eventJobService } from './services/queue/meta/events.job';
import { phaseJobService } from './services/queue/meta/phases.job';
import { teamJobService } from './services/queue/meta/teams.job';

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
app.use('/api/phases', phaseRouter);
app.use('/api/events', eventRouter);
app.use('/api/teams', teamRouter);
app.use('/api/monitor', monitorRouter);

let server: ReturnType<typeof app.listen> | null = null;

// Start server function
const startServer = async (customPort?: number) => {
  const serverPort = customPort || port;
  try {
    // Connect to the database
    await prisma.$connect();
    logger.info('Connected to database successfully');

    server = app.listen(serverPort, () => {
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

// Stop server function
const stopServer = async () => {
  if (server) {
    try {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
      // Disconnect from the database
      await prisma.$disconnect();
      logger.info('Server stopped and disconnected from database successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to stop server');
      throw error;
    }
  }
};

// Only start server if this file is run directly
if (require.main === module) {
  void startServer().catch((error) => {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  });
}

// Handle process termination
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully');
  void stopServer().catch((error) => {
    logger.error({ error }, 'Failed to stop server gracefully');
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully');
  void stopServer().catch((error) => {
    logger.error({ error }, 'Failed to stop server gracefully');
    process.exit(1);
  });
});

export { app, logger, prisma, startServer, stopServer };
