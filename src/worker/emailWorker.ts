import { Job } from 'bullmq';

import { QUEUE_CONFIG } from '../config/queue/queue.config';
import { getQueueLogger } from '../infrastructures/logger';
import { createWorker, setupGracefulShutdown } from '../infrastructures/queue/workerFactory';
import { createRedisConnection, disconnectRedis } from '../infrastructures/redis/connection';
import { EmailJobPayload, isEmailJobPayload } from '../types/jobs.type';
import { QueueName } from '../types/queues.type';

const logger = getQueueLogger();

const sendEmail = async (
  payload: EmailJobPayload,
): Promise<{ success: boolean; messageId?: string }> => {
  logger.info(`Simulating email send to: ${payload.to} Subject: ${payload.subject}`);
  await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
  const success = Math.random() > 0.1;

  if (success) {
    logger.info(`Email successfully sent to ${payload.to}`);
    return { success: true, messageId: `fake-id-${Date.now()}` };
  } else {
    logger.error(`Failed to send email to ${payload.to}`);
    throw new Error(`Simulated email failure for ${payload.to}`);
  }
};

const emailProcessor = async (
  job: Job<EmailJobPayload>,
): Promise<{ success: boolean; messageId?: string }> => {
  logger.debug(`Processing email job: ID=${job.id}, Type=${job.name}`, job.data);

  const payload = job.data;

  if (!isEmailJobPayload(payload)) {
    throw new Error(`Invalid payload structure for email job ID ${job.id}`);
  }

  try {
    const result = await sendEmail(payload);
    return result;
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(`Error processing email job ID ${job.id}: ${error.message}`, {
        stack: error.stack,
      });
    } else {
      logger.error(`Error processing email job ID ${job.id}: Unknown error`, {
        error,
      });
    }
    throw error;
  }
};

const startEmailWorker = async (): Promise<void> => {
  logger.info('Starting EMAIL worker...');
  try {
    const connection = await createRedisConnection();

    const worker = createWorker<EmailJobPayload>(QueueName.EMAIL, connection, emailProcessor, {
      concurrency: QUEUE_CONFIG.CONCURRENCY,
      limiter: { max: 10, duration: 1000 },
    });

    setupGracefulShutdown(worker);

    logger.info('EMAIL worker started successfully.');

    await new Promise(() => {});
  } catch (error) {
    logger.error('Failed to start EMAIL worker:', error);
    await disconnectRedis();
    process.exit(1);
  }
};

if (require.main === module) {
  startEmailWorker();
}
