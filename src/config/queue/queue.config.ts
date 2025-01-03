import IORedis from 'ioredis';
import { QueueConnection } from '../../types/queue.type';

export interface QueueConfig {
  readonly producerConnection: QueueConnection;
  readonly consumerConnection: QueueConnection;
}

// Create reusable Redis connections
const createProducerConnection = () =>
  new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: 1, // Fast failure for producers (e.g., HTTP endpoints)
  });

const createConsumerConnection = () =>
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
};

export const queueConfig: QueueConfig = {
  producerConnection: sharedConnections.producer,
  consumerConnection: sharedConnections.consumer,
};
