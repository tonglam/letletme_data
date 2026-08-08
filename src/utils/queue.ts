import type { RedisOptions } from 'ioredis';

import { getConfig, resolveQueueRedisConfig } from './config';

export type QueueConnection = RedisOptions;

export function getQueueConnection(): QueueConnection {
  return resolveQueueRedisConfig(getConfig());
}
