import { Job, Worker, WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { getQueueLogger } from '../../infrastructures/logger';
import { BaseJobPayload } from '../../types/jobs.type';
import { QueueName } from '../../types/queues.type';

const logger = getQueueLogger();

export type JobProcessor<T extends BaseJobPayload = any> = (job: Job<T>) => Promise<any>;

export const createWorker = <T extends BaseJobPayload>(
  queueName: QueueName,
  connection: Redis,
  processor: JobProcessor<T>,
  options?: Omit<WorkerOptions, 'connection'>,
): Worker<T> => {
  logger.info(`Creating worker for queue: ${queueName}`);

  const worker = new Worker<T>(queueName, processor, {
    concurrency: options?.concurrency ?? 5,
    removeOnComplete: { count: 1000, age: 24 * 3600 },
    removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
    ...options,
    connection: connection,
  });

  worker.on('completed', (job: Job, result: any) => {
    logger.info(`Job COMPLETED: [${queueName}] ID=${job?.id}, Result=${JSON.stringify(result)}`);
  });

  worker.on('failed', (job: Job | undefined, error: Error) => {
    logger.error(`Job FAILED: [${queueName}] ID=${job?.id}, Error: ${error.message}`, {
      jobData: job?.data,
      stack: error.stack,
    });
  });

  worker.on('error', (error: Error) => {
    logger.error(`Worker Error [${queueName}]: ${error.message}`, { stack: error.stack });
  });

  worker.on('active', (job: Job) => {
    logger.info(`Job ACTIVE: [${queueName}] ID=${job.id}`);
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn(`Job STALLED: [${queueName}] ID=${jobId}`);
  });

  logger.info(`Worker created for queue: ${queueName}`);
  return worker;
};

export const setupGracefulShutdown = (worker: Worker): void => {
  const shutdown = async () => {
    logger.info(`Shutting down worker for queue: ${worker.name}...`);
    try {
      await worker.close();
      logger.info(`Worker closed gracefully for queue: ${worker.name}.`);
      process.exit(0);
    } catch (err) {
      logger.error(`Error shutting down worker for queue ${worker.name}:`, err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};
