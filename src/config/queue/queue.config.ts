import IORedis from 'ioredis';
import { QueueConnection } from '../../types/queue.type';

// Queue configuration constants
export const QUEUE_CONFIG = {
  MAX_ATTEMPTS: 3,
  INITIAL_BACKOFF: 1000, // 1 second
  MAX_BACKOFF: 30000, // 30 seconds
  JOB_TIMEOUT: 30000, // 30 seconds
  CONCURRENCY: 2,
  RATE_LIMIT: {
    MAX: 5,
    DURATION: 1000, // 1 second
  },
  STALLED_CHECK_INTERVAL: 30000, // 30 seconds
  RETENTION: {
    COUNT: 100,
    AGE: 24 * 60 * 60 * 1000, // 24 hours
  },
  REDIS: {
    HOST: process.env.REDIS_HOST || 'localhost',
    PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
    MAX_RETRIES_PER_REQUEST: {
      PRODUCER: 1, // Fast failure for producers
      CONSUMER: null, // Persistent connections for consumers
    },
  },
} as const;

export interface QueueConfig {
  readonly connection: QueueConnection;
}

// Create Redis connection with configuration
const createRedisConnection = (isProducer = false): QueueConnection =>
  new IORedis({
    host: QUEUE_CONFIG.REDIS.HOST,
    port: QUEUE_CONFIG.REDIS.PORT,
    maxRetriesPerRequest: isProducer
      ? QUEUE_CONFIG.REDIS.MAX_RETRIES_PER_REQUEST.PRODUCER
      : QUEUE_CONFIG.REDIS.MAX_RETRIES_PER_REQUEST.CONSUMER,
    enableReadyCheck: !isProducer,
  });

// Shared connections for reuse
export const sharedConnections = {
  producer: createRedisConnection(true),
  consumer: createRedisConnection(false),
} as const;

// Default queue configuration
export const queueConfig: QueueConfig = {
  connection: sharedConnections.producer,
};
