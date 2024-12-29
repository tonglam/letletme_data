// Redis Client Module
//
// Provides a singleton Redis client instance for the application.
// Implements connection management and error handling for Redis operations.
// Uses fp-ts for functional error handling patterns.

import * as TE from 'fp-ts/TaskEither';
import { createClient } from 'redis';
import { REDIS_CLIENT_OPTIONS } from '../../config/cache/redis.config';
import type { CacheError, CacheErrorType } from './types';

// Global Redis client instance
// Ensures single client instance across the application
const globalForRedis = global as { redisClient?: ReturnType<typeof createClient> };

// Singleton Redis client instance
// Creates a new Redis client with configured options if none exists
export const redisClient =
  globalForRedis.redisClient ??
  createClient({
    ...REDIS_CLIENT_OPTIONS,
  });

// Development environment handling
// Preserves client instance during development hot reloads
if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisClient = redisClient;
}

// Error event handler for Redis client
// Logs Redis client errors for monitoring and debugging
redisClient.on('error', (error: Error) => console.error('Redis Client Error:', error));

// Establishes Redis connection
// Connects to Redis server if not already connected
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

// Disconnects from Redis
// Gracefully closes Redis connection if open
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
