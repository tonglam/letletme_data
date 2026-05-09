import type { RedisOptions } from 'ioredis';

import { getConfig } from './config';

export type QueueConnection = RedisOptions;

export function getQueueConnection(): QueueConnection {
  const config = getConfig();

  return {
    host: config.QUEUE_REDIS_HOST || config.REDIS_HOST,
    port: (config.QUEUE_REDIS_PORT || config.REDIS_PORT) as number,
    password: config.QUEUE_REDIS_PASSWORD || config.REDIS_PASSWORD,
    db: (config.QUEUE_REDIS_DB ?? config.REDIS_DB) as number,
  };
}
