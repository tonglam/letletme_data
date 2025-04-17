import IORedis, { Redis, RedisOptions } from 'ioredis';

const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const logger = console;

let redisClient: Redis | null = null;
let connectionPromise: Promise<Redis> | null = null;

const getRedisOptions = (): RedisOptions => {
  const host = getEnv('REDIS_HOST', 'localhost');
  const port = parseInt(getEnv('REDIS_PORT', '6379'), 10);
  const password = getEnv('REDIS_PASSWORD', undefined);

  if (isNaN(port)) {
    throw new Error(`Invalid REDIS_PORT: ${process.env.REDIS_PORT}`);
  }

  return {
    host,
    port,
    password,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times: number): number | null => {
      if (times > 10) {
        logger.error(`Redis connection failed after ${times} retries.`);
        return null;
      }
      const delay = Math.min(times * 100, 2000);
      logger.warn(`Redis connection retry attempt ${times}, delaying for ${delay}ms`);
      return delay;
    },
    reconnectOnError: (err: Error): boolean => {
      logger.error('Redis connection error during reconnect attempt:', err);
      return true;
    },
    lazyConnect: true,
  };
};

export const createRedisConnection = (): Promise<Redis> => {
  if (redisClient && redisClient.status === 'ready') {
    return Promise.resolve(redisClient);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise(async (resolve, reject) => {
    if (redisClient) {
      try {
        await redisClient
          .quit()
          .catch((err) => logger.warn('Error quitting previous redis client:', err));
      } finally {
        redisClient = null;
      }
    }

    const options = getRedisOptions();
    logger.info(`Attempting to connect to Redis at ${options.host}:${options.port}...`);
    const newClient = new IORedis(options);
    redisClient = newClient;

    const connectTimeout = setTimeout(() => {
      if (newClient.status !== 'ready') {
        logger.error('Redis initial connection timed out.');
        newClient.disconnect();
        redisClient = null;
        connectionPromise = null;
        reject(new Error('Redis initial connection timed out.'));
      }
    }, 15000);

    newClient.once('ready', () => {
      logger.info('Redis connection established successfully.');
      clearTimeout(connectTimeout);
      resolve(newClient);
    });

    newClient.once('error', (err) => {
      logger.error('Redis initial connection error:', err);
      clearTimeout(connectTimeout);
      newClient.disconnect();
      redisClient = null;
      connectionPromise = null;
      reject(new Error(`Redis initial connection failed: ${err.message}`));
    });
  });

  return connectionPromise;
};

export const disconnectRedis = async (): Promise<void> => {
  const clientToDisconnect = redisClient;
  const promiseToClear = connectionPromise;

  redisClient = null;
  connectionPromise = null;

  if (clientToDisconnect) {
    logger.info('Disconnecting Redis client...');
    try {
      await clientToDisconnect.quit();
      logger.info('Redis connection closed gracefully.');
    } catch (error) {
      logger.error('Error during Redis graceful quit:', error);
      try {
        clientToDisconnect.disconnect();
      } catch (forceErr) {
        logger.error('Error force disconnecting Redis:', forceErr);
      }
    }
  } else {
    logger.info('No active Redis client to disconnect.');
  }

  if (promiseToClear) {
    try {
      await promiseToClear;
    } catch (e) {
      logger.error('Error during Redis graceful quit:', e);
    }
  }
};

export const getRedisClient = (): Redis | null => {
  return redisClient;
};
