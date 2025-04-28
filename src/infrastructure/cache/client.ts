import * as TE from 'fp-ts/TaskEither';
import Redis from 'ioredis';
import { CacheError, CacheErrorCode, createCacheError } from 'types/error.type';

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
      createCacheError({
        code: CacheErrorCode.CONNECTION_ERROR,
        message: `Failed to connect to Redis: ${error}`,
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
      createCacheError({
        code: CacheErrorCode.CONNECTION_ERROR,
        message: `Failed to disconnect from Redis: ${error}`,
      }),
  );
