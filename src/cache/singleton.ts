import Redis from 'ioredis';

import { CacheConfig } from '../types';
import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';

// Cache commands must fail fast so services fall back to the database during a
// Redis outage (FP-03). BullMQ connections live elsewhere and intentionally do
// NOT use these timeouts (blocking commands must not time out).
const COMMAND_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 5000;
const INITIAL_PING_TIMEOUT_MS = 5000;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);

/**
 * Redis Singleton
 *
 * Manages a single Redis connection throughout the application lifecycle.
 * The client is created exactly once and never replaced over a live instance
 * (re-creating used to orphan still-reconnecting clients). `connect()` is
 * idempotent: concurrent callers share one in-flight attempt.
 *
 * `connectionOptions` exists for tests; production uses the app config.
 */
type RedisConnectionOptions = {
  host: string;
  port: number;
  password?: string;
  db: number;
};

const createRedisSingleton = (connectionOptions?: RedisConnectionOptions) => {
  let client: Redis | null = null;
  let isConnected = false;
  let connectPromise: Promise<void> | null = null;

  const resolveConnectionOptions = (): RedisConnectionOptions => {
    if (connectionOptions) {
      return connectionOptions;
    }
    const config = getConfig();
    return {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD,
      db: config.REDIS_DB,
    };
  };

  const getOrCreateClient = (): Redis => {
    if (client) {
      return client;
    }

    logInfo('Initializing Redis connection...');

    const { host, port, password, db } = resolveConnectionOptions();
    const redisConfig = {
      host,
      port,
      password,
      db,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      lazyConnect: true,
    };

    client = new Redis(redisConfig);

    client.on('connect', () => {
      isConnected = true;
      logInfo('✅ Redis client connected');
    });

    client.on('ready', () => {
      logInfo('✅ Redis client ready');
    });

    client.on('error', (error) => {
      logError('❌ Redis client error', error);
      isConnected = false;
    });

    client.on('close', () => {
      logInfo('Redis client connection closed');
      isConnected = false;
    });

    client.on('reconnecting', () => {
      logInfo('Redis client reconnecting...');
    });

    return client;
  };

  const connect = async (): Promise<void> => {
    if (isConnected) {
      return;
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      const redis = getOrCreateClient();
      try {
        // ioredis only accepts connect() from the 'wait'/'end' states; in any
        // other state it is already connecting/connected on its own.
        if (redis.status === 'wait' || redis.status === 'end') {
          await redis.connect();
        }
        // Race the ping so a black-holed socket can't leave a connection
        // attempt pending forever (commandTimeout backs this up too).
        await withTimeout(redis.ping(), INITIAL_PING_TIMEOUT_MS, 'Initial Redis ping');
        isConnected = true;
        logInfo('✅ Redis connection established');
      } catch (error) {
        isConnected = false;
        logError('❌ Failed to connect to Redis', error);
        throw error;
      } finally {
        connectPromise = null;
      }
    })();

    return connectPromise;
  };

  return {
    /**
     * Initialize Redis connection (lazy, idempotent)
     */
    connect,

    /**
     * Get the Redis client (auto-connects if needed)
     */
    getClient: async (): Promise<Redis> => {
      if (!isConnected) {
        await connect();
      }

      if (!client) {
        throw new Error('Redis client not initialized');
      }

      return client;
    },

    /**
     * Check if Redis is connected
     */
    isHealthy: (): boolean => {
      return isConnected && client !== null;
    },

    /**
     * Test Redis connection
     */
    healthCheck: async (): Promise<boolean> => {
      try {
        if (!isConnected || !client) {
          return false;
        }

        const result = await client.ping();
        return result === 'PONG';
      } catch (error) {
        logError('Redis health check failed', error);
        return false;
      }
    },

    /**
     * Close Redis connection (the shared instance is kept for reuse)
     */
    disconnect: async (): Promise<void> => {
      if (!client) {
        return;
      }

      try {
        logInfo('Closing Redis connection...');
        client.disconnect();
        isConnected = false;
        logInfo('✅ Redis connection closed');
      } catch (error) {
        logError('❌ Error closing Redis connection', error);
        throw error;
      }
    },

    /**
     * Force reconnection on the same client instance (never orphans a client)
     */
    reconnect: async (): Promise<void> => {
      const redis = getOrCreateClient();
      redis.disconnect();
      isConnected = false;
      await connect();
    },

    /**
     * Get connection status
     */
    getStatus: (): { connected: boolean; connecting: boolean } => {
      return {
        connected: isConnected,
        connecting: connectPromise !== null,
      };
    },
  };
};

// Export singleton instance
export const redisSingleton = createRedisSingleton();

// Exported for tests that need an isolated client lifecycle (e.g. timeout tests)
export { createRedisSingleton };

// Default cache configuration
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttl: 300, // 5 minutes
  prefix: 'letletme:',
};

// Cache TTL configurations for different data types
// TTL -1 means no expiration (cache persists indefinitely until manually deleted)
export const CACHE_TTL = {
  // Basic/Static Data - No expiration (TTL -1)
  EVENTS: -1, // No expiration
  TEAMS: -1, // No expiration
  PHASES: -1, // No expiration
  PLAYERS: -1, // No expiration

  // Game Data - No expiration (TTL -1)
  FIXTURES: -1, // No expiration
  PLAYER_STATS: -1, // No expiration
  PLAYER_VALUES: -1, // No expiration

  // Entry Data - No expiration (TTL -1)
  ENTRY_INFOS: -1, // No expiration

  // Live Match Data - No expiration (TTL -1)
  EVENT_LIVE: -1, // No expiration
  EVENT_LIVE_EXPLAIN: -1, // No expiration
  LIVE_FIXTURE: -1, // No expiration
  LIVE_BONUS: -1, // No expiration
  LIVE_DATA: -1, // No expiration

  // Aggregated/Historical Data - No expiration (TTL -1)
  EVENT_LIVE_SUMMARY: -1, // No expiration
  EVENT_OVERALL_RESULT: -1, // No expiration
} as const;

// Convenience export for backward compatibility
export const getRedis = () => redisSingleton.getClient();
