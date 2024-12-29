/**
 * Redis Client Module
 *
 * Singleton Redis client instance for the application.
 */

import * as TE from 'fp-ts/TaskEither';
import { createClient } from 'redis';
import { REDIS_CLIENT_OPTIONS } from '../../config/cache/redis.config';
import { CacheError, CacheErrorType } from './types';

/**
 * Global Redis client instance
 */
const globalForRedis = global as { redisClient?: ReturnType<typeof createClient> };

/**
 * Singleton Redis client instance
 */
export const redisClient =
  globalForRedis.redisClient ??
  createClient({
    ...REDIS_CLIENT_OPTIONS,
  });

/**
 * Development environment handling
 */
if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisClient = redisClient;
}

/**
 * Error event handler for Redis client
 */
redisClient.on('error', (error: Error) => console.error('Redis Client Error:', error));

/**
 * Establishes Redis connection
 */
export const connectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
    },
    (error): CacheError => ({
      type: CacheErrorType.CONNECTION,
      message: `Failed to connect to Redis: ${error}`,
    }),
  );

/**
 * Disconnects from Redis
 */
export const disconnectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (redisClient.isOpen) {
        await redisClient.quit();
      }
    },
    (error): CacheError => ({
      type: CacheErrorType.CONNECTION,
      message: `Failed to disconnect from Redis: ${error}`,
    }),
  );
