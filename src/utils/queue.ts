import type { QueueOptions } from 'bullmq';

import { getConfig } from './config';

export const DATA_SYNC_QUEUE_NAME = 'data-sync';

export type QueueConnection = QueueOptions['connection'];

export function getQueueConnection(): QueueConnection {
  const config = getConfig();

  return {
    host: config.QUEUE_REDIS_HOST || config.REDIS_HOST,
    port: (config.QUEUE_REDIS_PORT || config.REDIS_PORT) as number,
    password: config.QUEUE_REDIS_PASSWORD || config.REDIS_PASSWORD,
    db: (config.QUEUE_REDIS_DB ?? config.REDIS_DB) as number,
  };
}
