import { Queue, QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';

import { getQueueLogger } from '../../infrastructures/logger';
import { BaseJobPayload } from '../../types/jobs.type';
import { QueueName } from '../../types/queues.type';

const logger = getQueueLogger();

const getDefaultQueueOptions = (connection: Redis): QueueOptions => ({
  connection,
});

export const createQueue = <T extends BaseJobPayload = BaseJobPayload>(
  connection: Redis,
  name: QueueName,
  options?: Omit<QueueOptions, 'connection'>,
): Queue<T> => {
  logger.info(`Initializing queue: ${name}`);
  const defaultOptions = getDefaultQueueOptions(connection);
  const queue = new Queue<T>(name, {
    ...defaultOptions,
    ...options,
    connection: defaultOptions.connection,
  });

  queue.on('error', (error) => {
    logger.error(`Queue Error [${name}]:`, error);
  });

  return queue;
};

export interface ManagedQueueConfig {
  name: QueueName;
  options?: Omit<QueueOptions, 'connection'>;
}

export const initializeManagedQueues = (
  connection: Redis,
  queueConfigs: ManagedQueueConfig[],
): Map<QueueName, Queue> => {
  logger.info(`Initializing ${queueConfigs.length} managed queues...`);
  const queues = new Map<QueueName, Queue>();

  for (const config of queueConfigs) {
    if (queues.has(config.name)) {
      logger.warn(`Duplicate queue configuration detected for [${config.name}]. Skipping.`);
      continue;
    }
    try {
      const queue = createQueue(connection, config.name, config.options);
      queues.set(config.name, queue);
      logger.info(`Successfully initialized queue: ${config.name}`);
    } catch (error) {
      logger.error(`Failed to initialize queue [${config.name}]:`, error);
    }
  }

  logger.info('Managed queues initialization finished.');
  return queues;
};

export const closeManagedQueues = async (queues: Map<QueueName, Queue>): Promise<void> => {
  logger.info(`Closing ${queues.size} managed queues...`);
  const closePromises = Array.from(queues.entries()).map(([name, queue]) =>
    queue
      .close()
      .then(() => logger.info(`Queue [${name}] closed.`))
      .catch((error) => {
        logger.error(`Error closing queue [${name}]:`, error);
      }),
  );

  await Promise.allSettled(closePromises);
  logger.info('Finished closing managed queues.');
};

export const getQueue = <T extends BaseJobPayload = BaseJobPayload>(
  queues: Map<QueueName, Queue>,
  queueName: QueueName,
): Queue<T> => {
  const queue = queues.get(queueName);
  if (!queue) {
    throw new Error(`Queue [${queueName}] was not found in the managed queue map.`);
  }
  return queue as Queue<T>;
};
