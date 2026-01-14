import Redis from 'ioredis';

import { CacheConfig } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Redis Singleton
 * Manages a single Redis connection throughout the application lifecycle
 */
class RedisSingleton {
  private static instance: RedisSingleton;
  private client: Redis | null = null;
  private isConnected = false;
  private isConnecting = false;

  private constructor() {
    // Private constructor prevents direct instantiation
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): RedisSingleton {
    if (!RedisSingleton.instance) {
      RedisSingleton.instance = new RedisSingleton();
    }
    return RedisSingleton.instance;
  }

  /**
   * Initialize Redis connection (lazy initialization)
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      return; // Already connected
    }

    if (this.isConnecting) {
      // Wait for existing connection attempt
      while (this.isConnecting) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    try {
      this.isConnecting = true;
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

      this.client = new Redis(redisConfig);

      // Set up event handlers
      this.client.on('connect', () => {
        this.isConnected = true;
        logInfo('✅ Redis client connected');
      });

      this.client.on('ready', () => {
        logInfo('✅ Redis client ready');
      });

      this.client.on('error', (error) => {
        logError('❌ Redis client error', error);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        logInfo('Redis client connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        logInfo('Redis client reconnecting...');
      });

      // Test connection
      await this.client.ping();

      logInfo('✅ Redis connection established');
    } catch (error) {
      logError('❌ Failed to connect to Redis', error);
      this.isConnected = false;
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Get the Redis client (auto-connects if needed)
   */
  public async getClient(): Promise<Redis> {
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  public isHealthy(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Test Redis connection
   */
  public async healthCheck(): Promise<boolean> {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      logError('Redis health check failed', error);
      return false;
    }
  }

  /**
   * Close Redis connection
   */
  public async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      logInfo('Closing Redis connection...');
      await this.client.disconnect();
      this.client = null;
      this.isConnected = false;
      logInfo('✅ Redis connection closed');
    } catch (error) {
      logError('❌ Error closing Redis connection', error);
      throw error;
    }
  }

  /**
   * Force reconnection (useful for connection recovery)
   */
  public async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Get connection status
   */
  public getStatus(): { connected: boolean; connecting: boolean } {
    return {
      connected: this.isConnected,
      connecting: this.isConnecting,
    };
  }
}

// Export singleton instance
export const redisSingleton = RedisSingleton.getInstance();

// Default cache configuration
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttl: 300, // 5 minutes
  prefix: 'letletme:',
};

// Cache TTL configurations for different data types
export const CACHE_TTL = {
  EVENTS: 3600, // 1 hour
  TEAMS: 86400, // 24 hours
  PHASES: 86400, // 24 hours (phases change rarely)
  PLAYERS: 3600, // 1 hour
  FIXTURES: 1800, // 30 minutes
  LIVE_DATA: 60, // 1 minute
  EVENT_LIVE: 120, // 2 minutes (live data updates frequently during matches)
  EVENT_LIVE_SUMMARY: 86400, // 24 hours (season-to-date summary)
  EVENT_LIVE_EXPLAIN: 120, // 2 minutes (live explain data updates frequently during matches)
  EVENT_OVERALL_RESULT: 86400, // 24 hours
  EVENT_STANDINGS: 86400, // 24 hours
  player_values: 7200, // 2 hours (player values change relatively slowly)
} as const;

// Convenience export for backward compatibility
export const getRedis = () => redisSingleton.getClient();
