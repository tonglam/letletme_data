/**
 * Redis Client Module
 *
 * Provides a singleton Redis client instance for the application.
 * Handles connection management and error handling.
 *
 * Features:
 * - Singleton pattern implementation
 * - Global instance management
 * - Connection lifecycle handling
 * - Error monitoring and reporting
 * - Functional error handling with TaskEither
 *
 * The module ensures a single Redis connection is maintained
 * throughout the application lifecycle, with proper error handling
 * and connection management.
 */

import * as TE from 'fp-ts/TaskEither';
import { createClient } from 'redis';
import { REDIS_CLIENT_OPTIONS } from '../../config/cache/redis.config';
import { CacheError, CacheErrorType } from './types';

/**
 * Global Redis client instance.
 * Ensures single instance across Node.js module system.
 */
const globalForRedis = global as { redisClient?: ReturnType<typeof createClient> };

/**
 * Singleton Redis client instance.
 * Created with configured options and reused across the application.
 */
export const redisClient =
  globalForRedis.redisClient ??
  createClient({
    ...REDIS_CLIENT_OPTIONS,
  });

/**
 * Development environment handling.
 * Preserves Redis client instance across hot reloads.
 */
if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisClient = redisClient;
}

/**
 * Error event handler for Redis client.
 * Logs errors for monitoring and debugging.
 */
redisClient.on('error', (error: Error) => console.error('Redis Client Error:', error));

/**
 * Establishes connection to Redis server.
 * Handles connection lifecycle and error states.
 *
 * @returns TaskEither indicating connection success or failure
 * @throws CacheError with CONNECTION type if connection fails
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
 * Gracefully disconnects from Redis server.
 * Ensures proper cleanup of resources.
 *
 * @returns TaskEither indicating disconnection success or failure
 * @throws CacheError with CONNECTION type if disconnection fails
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
