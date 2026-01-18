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
export const CACHE_TTL = {
  // Basic/Static Data - Long TTL (7-30 days)
  EVENTS: 604800, // 7 days
  TEAMS: 2592000, // 30 days (rarely change mid-season)
  PHASES: 2592000, // 30 days (rarely change)
  PLAYERS: 86400, // 24 hours (updates more frequently)
  
  // Game Data - Moderate TTL (2-6 hours)
  FIXTURES: 21600, // 6 hours
  PLAYER_STATS: 7200, // 2 hours
  player_values: 7200, // 2 hours
  
  // Live Match Data - Short TTL (2 minutes)
  EVENT_LIVE: 120, // 2 minutes (live data updates frequently during matches)
  EVENT_LIVE_EXPLAIN: 120, // 2 minutes (live explain data updates frequently during matches)
  LIVE_DATA: 60, // 1 minute
  
  // Aggregated/Historical Data - Long TTL (24 hours)
  EVENT_LIVE_SUMMARY: 86400, // 24 hours (season-to-date summary)
  EVENT_OVERALL_RESULT: 86400, // 24 hours
  EVENT_STANDINGS: 86400, // 24 hours
} as const;

// Convenience export for backward compatibility
export const getRedis = () => redisSingleton.getClient();
