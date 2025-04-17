import { addJob } from './infrastructures/queue/jobManager';
import { initializeManagedQueues, ManagedQueueConfig } from './infrastructures/queue/queueManager';
import { createRedisConnection, disconnectRedis } from './infrastructures/redis/connection';
import { EmailJobPayload } from './types/jobs.type';
import { QueueName } from './types/queues.type';

const logger = console;

const queueConfigs: ManagedQueueConfig[] = [{ name: QueueName.EMAIL }, { name: QueueName.META }];

async function main() {
  logger.info('Application starting...');

  try {
    // 1. Connect to Redis
    const redisConnection = await createRedisConnection();
    logger.info('Redis connection established for main application.');

    // 2. Initialize BullMQ Queues
    const queues = initializeManagedQueues(redisConnection, queueConfigs);
    logger.info('Managed queues initialized.');

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

    logger.info('Application running. (Simulated work - press Ctrl+C to exit)');
  } catch (error) {
    logger.error('Application failed to start:', error);
    await gracefulShutdown();
    process.exit(1);
  }
}

async function gracefulShutdown() {
  logger.info('Initiating graceful shutdown...');

  await disconnectRedis();
  logger.info('Graceful shutdown completed.');
  process.exit(0);
}

// Setup shutdown handlers for the main application process
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

main();
