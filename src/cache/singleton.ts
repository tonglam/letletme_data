import Redis from 'ioredis';

import { CacheConfig } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Redis Singleton
 * Manages a single Redis connection throughout the application lifecycle
 */
const createRedisSingleton = () => {
  let client: Redis | null = null;
  let isConnected = false;
  let isConnecting = false;

  return {
    /**
     * Initialize Redis connection (lazy initialization)
     */
    connect: async (): Promise<void> => {
      if (isConnected) {
        return; // Already connected
      }

      if (isConnecting) {
        // Wait for existing connection attempt
        while (isConnecting) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return;
      }

      try {
        isConnecting = true;
        logInfo('Initializing Redis connection...');

        const redisConfig = {
          host: process.env.REDIS_HOST || 'localhost',
          port: Number(process.env.REDIS_PORT) || 6379,
          password: process.env.REDIS_PASSWORD,
          db: Number(process.env.REDIS_DB) || 0,
          retryDelayOnFailover: 100,
          enableReadyCheck: false,
          maxRetriesPerRequest: null,
        };

        client = new Redis(redisConfig);

        // Set up event handlers
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

        // Test connection
        await client.ping();

        logInfo('✅ Redis connection established');
      } catch (error) {
        logError('❌ Failed to connect to Redis', error);
        isConnected = false;
        throw error;
      } finally {
        isConnecting = false;
      }
    },

    /**
     * Get the Redis client (auto-connects if needed)
     */
    getClient: async (): Promise<Redis> => {
      if (!isConnected) {
        await redisSingleton.connect();
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
     * Close Redis connection
     */
    disconnect: async (): Promise<void> => {
      if (!client) {
        return;
      }

      try {
        logInfo('Closing Redis connection...');
        await client.disconnect();
        client = null;
        isConnected = false;
        logInfo('✅ Redis connection closed');
      } catch (error) {
        logError('❌ Error closing Redis connection', error);
        throw error;
      }
    },

    /**
     * Force reconnection (useful for connection recovery)
     */
    reconnect: async (): Promise<void> => {
      await redisSingleton.disconnect();
      await redisSingleton.connect();
    },

    /**
     * Get connection status
     */
    getStatus: (): { connected: boolean; connecting: boolean } => {
      return {
        connected: isConnected,
        connecting: isConnecting,
      };
    },
  };
};

// Export singleton instance
export const redisSingleton = createRedisSingleton();

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
