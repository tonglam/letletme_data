import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { RedisConfig, RedisConfigCodec, RetryStrategy } from 'infrastructure/cache/types';
import { failure } from 'io-ts/lib/PathReporter';

// Default configuration values
const DEFAULT_CONFIG = {
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  enableOfflineQueue: false,
} as const;

// Default retry strategy
const defaultRetryStrategy: RetryStrategy = (times: number): number | null => {
  const maxRetryAttempts = 3;
  if (times > maxRetryAttempts) {
    return null; // Stop retrying
  }
  return Math.min(times * 1000, 3000); // Exponential backoff capped at 3s
};

// Load and validate configuration
export const loadRedisConfig = (): E.Either<Error, RedisConfig> =>
  pipe(
    {
      host: process.env.REDIS_HOST ?? DEFAULT_CONFIG.host,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : DEFAULT_CONFIG.port,
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
      maxRetriesPerRequest: DEFAULT_CONFIG.maxRetriesPerRequest,
      retryStrategy: defaultRetryStrategy,
      lazyConnect: DEFAULT_CONFIG.lazyConnect,
      enableOfflineQueue: DEFAULT_CONFIG.enableOfflineQueue,
    },
    (config) =>
      pipe(
        RedisConfigCodec.decode(config),
        E.mapLeft((errors) => new Error(failure(errors).join('\n'))),
        E.map((validatedConfig) => ({
          ...validatedConfig,
          retryStrategy: defaultRetryStrategy,
          lazyConnect: DEFAULT_CONFIG.lazyConnect,
          enableOfflineQueue: DEFAULT_CONFIG.enableOfflineQueue,
        })),
      ),
  );
