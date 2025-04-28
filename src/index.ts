import { Server } from 'http';

import * as E from 'fp-ts/Either';
import { addJob } from 'infrastructures/queue/jobManager';
import { initializeManagedQueues, ManagedQueueConfig } from 'infrastructures/queue/queueManager';
import { createRedisConnection, disconnectRedis } from 'infrastructures/redis/connection';
import { EmailJobPayload } from 'types/jobs.type';
import { QueueName } from 'types/queues.type';

import { initializeApp } from './app/initializer';

const logger = console;

const queueConfigs: ManagedQueueConfig[] = [{ name: QueueName.EMAIL }, { name: QueueName.META }];

let httpServer: Server | null = null;

async function main() {
  logger.info('Application starting...');

  try {
    // 1. Connect to Redis
    const redisConnection = await createRedisConnection();
    logger.info('Redis connection established.');

    // 2. Initialize BullMQ Queues
    const queues = initializeManagedQueues(redisConnection, queueConfigs);
    logger.info('Managed queues initialized.');

    // 3. Initialize and start HTTP Server
    logger.info('Initializing HTTP server...');
    const initResult = await initializeApp()();

    if (E.isLeft(initResult)) {
      logger.error('HTTP server initialization failed:', initResult.left);
      throw initResult.left;
    }

    httpServer = initResult.right;
    logger.info('HTTP server started successfully.');

    // --- Example: Add a test email job ---
    try {
      const emailQueue = queues.get(QueueName.EMAIL);
      if (emailQueue) {
        const jobData: EmailJobPayload = {
          to: 'test@example.com',
          subject: 'Test Email from BullMQ',
          body: '<h1>Hello!</h1><p>This is a test job.</p>',
          source: 'application-startup',
        };
        await addJob<EmailJobPayload>(emailQueue, 'send-test-email', jobData);
        logger.info('Test email job added.');
      }
    } catch (jobError) {
      logger.error('Failed to add test job:', jobError);
    }
    // --- End Example ---

    logger.info('Application running. (Background jobs and HTTP server active)');
  } catch (error) {
    logger.error('Application failed to start or encountered an error:', error);
    await gracefulShutdown();
    process.exit(1);
  }
}

async function gracefulShutdown() {
  logger.info('Initiating graceful shutdown...');

  if (httpServer) {
    logger.info('Closing HTTP server...');
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((err) => {
        if (err) {
          logger.error('Error closing HTTP server:', err);
          reject(err);
        } else {
          logger.info('HTTP server closed.');
          resolve();
        }
      });
    });
    httpServer = null;
  }

  await disconnectRedis();
  logger.info('Redis connection closed.');

  logger.info('Graceful shutdown completed.');
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

main();
