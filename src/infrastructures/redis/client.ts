import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import IORedis, { Redis, RedisOptions } from 'ioredis';
import { createServiceError, ServiceErrorCode } from '../../types/error.type';

let redisClient: Redis | null = null;

export const DEFAULT_OPTIONS: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  keyPrefix: process.env.NODE_ENV === 'production' ? 'prod:' : 'dev:',
  retryStrategy: (times: number) => {
    if (times > 3) {
      return null;
    }
    return Math.min(times * 1000, 3000);
  },
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
};

export const TEST_OPTIONS: RedisOptions = {
  ...DEFAULT_OPTIONS,
  keyPrefix: 'test:',
  retryStrategy: (times: number) => {
    if (times > 5) {
      return null;
    }
    return Math.min(times * 1000, 5000);
  },
  maxRetriesPerRequest: 5,
  connectTimeout: 10000,
  commandTimeout: 10000,
  lazyConnect: false,
  enableOfflineQueue: true,
};

export const createRedisClient = (options: RedisOptions = {}): TE.TaskEither<Error, Redis> =>
  pipe(
    TE.tryCatch(
      async () => {
        if (!redisClient) {
          redisClient = new IORedis({
            ...DEFAULT_OPTIONS,
            ...options,
          });

          await new Promise<void>((resolve, reject) => {
            redisClient?.once('ready', () => resolve());
            redisClient?.once('error', (err) => reject(err));
          });
        }
        return redisClient;
      },
      (error) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to create Redis client',
          cause: error as Error,
        }),
    ),
  );

export const getRedisClient = (): Redis | null => redisClient;

export const closeRedisClient = async (): Promise<void> => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
};
