import { CacheError, CacheErrorCode, createCacheError } from '@app/infrastructure/cache/error';
import { CachePrefix, DefaultTTL } from '@app/infrastructure/config/cache.config';
import * as TE from 'fp-ts/TaskEither';
import Redis from 'ioredis';

const globalForRedis = global as { redisClient?: Redis };

export const redisClient =
  globalForRedis.redisClient ??
  new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisClient = redisClient;
}

redisClient.on('error', (error) => {
  console.error('Redis connection error:', error);
});

export const connectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (redisClient.status !== 'ready') {
        await redisClient.connect();
      }
    },
    (error) =>
      createCacheError(CacheErrorCode.CONNECTION_ERROR, {
        message: `Failed to connect to Redis: ${error instanceof Error ? error.message : String(error)}`,
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
  );

export const disconnectRedis = (): TE.TaskEither<CacheError, void> =>
  TE.tryCatch(
    async () => {
      if (redisClient.status === 'ready') {
        await redisClient.quit();
      }
    },
    (error) =>
      createCacheError(CacheErrorCode.CONNECTION_ERROR, {
        message: `Failed to disconnect from Redis: ${error instanceof Error ? error.message : String(error)}`,
        cause: error instanceof Error ? error : new Error(String(error)),
      }),
  );

export interface CacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}
