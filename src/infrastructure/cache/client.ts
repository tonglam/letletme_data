// Redis Client Module
//
// Provides a singleton Redis client instance for the application.
// Implements connection management and error handling for Redis operations.
// Uses fp-ts for functional error handling patterns.

import * as TE from 'fp-ts/TaskEither';
import Redis from 'ioredis';
import { REDIS_CONFIG } from '../../config/cache/redis.config';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';

// Global Redis client instance
// Ensures single client instance across the application
const globalForRedis = global as { redisClient?: Redis };

// Singleton Redis client instance
// Creates a new Redis client with configured options if none exists
export const redisClient =
  globalForRedis.redisClient ??
  new Redis({
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    password: REDIS_CONFIG.password,
    db: REDIS_CONFIG.db,
  });

// Development environment handling
// Preserves client instance during development hot reloads
if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisClient = redisClient;
}

// Error handling
redisClient.on('error', (error) => {
  console.error('Redis connection error:', error);
});

// Establishes Redis connection
// Connects to Redis server if not already connected
export const connectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (redisClient.status !== 'ready') {
        await redisClient.connect();
      }
    },
    (error) =>
      createCacheError({
        code: CacheErrorCode.CONNECTION_ERROR,
        message: `Failed to connect to Redis: ${error}`,
      }),
  );

// Disconnects from Redis
// Gracefully closes Redis connection if open
export const disconnectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (redisClient.status === 'ready') {
        await redisClient.quit();
      }
    },
    (error) =>
      createCacheError({
        code: CacheErrorCode.CONNECTION_ERROR,
        message: `Failed to disconnect from Redis: ${error}`,
      }),
  );
