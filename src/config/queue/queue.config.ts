import { QueueConnection } from 'infrastructure/queue/types';
import IORedis from 'ioredis';

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
    HOST: process.env.NODE_ENV === 'test' ? 'localhost' : process.env.REDIS_HOST || 'localhost',
    PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
    PASSWORD: process.env.NODE_ENV === 'test' ? undefined : process.env.REDIS_PASSWORD,
    MAX_RETRIES_PER_REQUEST: {
      PRODUCER: 1, // Fast failure for producers
      CONSUMER: null, // Persistent connections for consumers
    },
  },
} as const;

// Create Redis connection with configuration
const createRedisConnection = (isProducer = false): QueueConnection =>
  new IORedis({
    host: QUEUE_CONFIG.REDIS.HOST,
    port: QUEUE_CONFIG.REDIS.PORT,
    password: QUEUE_CONFIG.REDIS.PASSWORD,
    maxRetriesPerRequest: isProducer
      ? QUEUE_CONFIG.REDIS.MAX_RETRIES_PER_REQUEST.PRODUCER
      : QUEUE_CONFIG.REDIS.MAX_RETRIES_PER_REQUEST.CONSUMER,
    enableReadyCheck: !isProducer,
    lazyConnect: true, // Only connect when needed
  });

// Shared connections for reuse
export const sharedConnections = {
  producer: createRedisConnection(true),
  consumer: createRedisConnection(false),
} as const;

// Initialize shared connections
export const initializeConnections = async (): Promise<void> => {
  await Promise.all([sharedConnections.producer.connect(), sharedConnections.consumer.connect()]);
};

// Close shared connections
export const closeConnections = async (): Promise<void> => {
  await Promise.all([
    sharedConnections.producer.disconnect(),
    sharedConnections.consumer.disconnect(),
  ]);
};
