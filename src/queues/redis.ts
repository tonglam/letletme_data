import Redis from 'ioredis';

import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';

let client: Redis | null = null;
let connectPromise: Promise<void> | null = null;
export const QUEUE_REDIS_HEALTH_TIMEOUT_MS = 5000;
export const QUEUE_REDIS_CONNECT_TIMEOUT_MS = 5000;
export const QUEUE_REDIS_COMMAND_TIMEOUT_MS = 5000;

async function withQueueRedisTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function pingQueueRedisWithTimeout(
  redis: Pick<Redis, 'ping'>,
  timeoutMs = QUEUE_REDIS_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const result = await withQueueRedisTimeout(redis.ping(), timeoutMs, 'Queue Redis health ping');
  return result === 'PONG';
}

export async function connectQueueRedisWithTimeout(
  redis: Pick<Redis, 'connect' | 'disconnect'>,
  timeoutMs = QUEUE_REDIS_CONNECT_TIMEOUT_MS,
): Promise<void> {
  try {
    await withQueueRedisTimeout(redis.connect(), timeoutMs, 'Queue Redis connection');
  } catch (error) {
    redis.disconnect();
    throw error;
  }
}

function getOrCreateClient(): Redis {
  if (client) return client;

  const connection = getQueueConnection();
  client = new Redis({
    host: connection.host,
    port: connection.port,
    password: connection.password,
    db: connection.db,
    enableReadyCheck: true,
    connectTimeout: QUEUE_REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: QUEUE_REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  client.on('error', (error) => logError('Queue Redis client error', error));
  client.on('ready', () => logInfo('Queue Redis client ready'));
  return client;
}

export const queueRedisSingleton = {
  getClient: async (): Promise<Redis> => {
    const redis = getOrCreateClient();
    if (redis.status === 'ready') return redis;
    if (!connectPromise && (redis.status === 'wait' || redis.status === 'end')) {
      connectPromise = connectQueueRedisWithTimeout(redis).finally(() => {
        connectPromise = null;
      });
    }
    if (connectPromise) await connectPromise;
    return redis;
  },

  healthCheck: async (): Promise<boolean> => {
    try {
      const redis = await queueRedisSingleton.getClient();
      return await pingQueueRedisWithTimeout(redis);
    } catch (error) {
      logError('Queue Redis health check failed', error);
      return false;
    }
  },

  disconnect: async (): Promise<void> => {
    if (!client) return;
    client.disconnect();
    client = null;
    connectPromise = null;
  },
};
