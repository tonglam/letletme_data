import IORedis, { Redis } from 'ioredis';
import { logger } from '../../utils/logger';
import { redisOptions } from './config';

const redisLogger = logger.child({ component: 'Redis' });

// Create a shared Redis connection for Queue and Worker instances
export const sharedRedisConnection: Redis = new IORedis(redisOptions);

sharedRedisConnection.on('connect', () => {
  redisLogger.info('Shared Redis connection established');
});

sharedRedisConnection.on('error', (error: Error) => {
  redisLogger.error({ error: error.message }, 'Shared Redis connection error');
});

// Create dedicated connections for QueueScheduler and QueueEvents
export const createDedicatedConnection = (prefix?: string): Redis => {
  const client = new IORedis({
    ...redisOptions,
    keyPrefix: prefix ? `${prefix}:` : undefined,
  });

  client.on('connect', () => {
    redisLogger.info({ prefix }, 'Dedicated Redis connection established');
  });

  client.on('error', (error: Error) => {
    redisLogger.error({ error: error.message, prefix }, 'Dedicated Redis connection error');
  });

  return client;
};
