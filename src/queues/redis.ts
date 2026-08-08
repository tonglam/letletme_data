import Redis from 'ioredis';

import { logError, logInfo } from '../utils/logger';
import { getQueueConnection } from '../utils/queue';

let client: Redis | null = null;

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
      return (await redis.ping()) === 'PONG';
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
