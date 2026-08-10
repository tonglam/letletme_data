import Redis from 'ioredis';

import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';

let client: Redis | null = null;
export const QUEUE_REDIS_HEALTH_TIMEOUT_MS = 5000;

export async function pingQueueRedisWithTimeout(
  redis: Pick<Redis, 'ping'>,
  timeoutMs = QUEUE_REDIS_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Queue Redis health ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return result === 'PONG';
  } finally {
    if (timeout) clearTimeout(timeout);
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
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  client.on('error', (error) => logError('Queue Redis client error', error));
  client.on('ready', () => logInfo('Queue Redis client ready'));
  return client;
}

export const queueRedisSingleton = {
  getClient: async (): Promise<Redis> => {
    const redis = getOrCreateClient();
    if (redis.status === 'wait' || redis.status === 'end') {
      await redis.connect();
    }
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
  },
};
