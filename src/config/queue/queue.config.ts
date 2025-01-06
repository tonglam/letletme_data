import IORedis from 'ioredis';
import { QueueConnection } from '../../types/queue.type';

export interface QueueConfig {
  readonly connection: QueueConnection;
  readonly producerConnection?: QueueConnection;
  readonly consumerConnection?: QueueConnection;
}

// Create reusable Redis connections
export const createProducerConnection = (): QueueConnection =>
  new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: 1, // Fast failure for producers (e.g., HTTP endpoints)
  });

export const createConsumerConnection = (): QueueConnection =>
  new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null, // Persistent connections for consumers
    enableReadyCheck: true,
  });

// Shared connections for reuse
export const sharedConnections = {
  producer: createProducerConnection(),
  consumer: createConsumerConnection(),
} as const;

export const queueConfig: QueueConfig = {
  connection: sharedConnections.producer,
};
