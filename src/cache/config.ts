import Redis from 'ioredis';

import { CacheConfig } from '../types';
import { logError, logInfo } from '../utils/logger';

// Redis client configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB) || 0,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
};

// Create Redis client
export const redis = new Redis(redisConfig);

// Redis event handlers
redis.on('connect', () => {
  logInfo('Redis client connected');
});

redis.on('ready', () => {
  logInfo('Redis client ready');
});

redis.on('error', (error) => {
  logError('Redis client error', error);
});

redis.on('close', () => {
  logInfo('Redis client connection closed');
});

// Default cache configuration
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  ttl: 300, // 5 minutes
  prefix: 'letletme:',
};

// Cache TTL configurations for different data types
export const CACHE_TTL = {
  EVENTS: 3600, // 1 hour
  TEAMS: 86400, // 24 hours
  PLAYERS: 3600, // 1 hour
  FIXTURES: 1800, // 30 minutes
  LIVE_DATA: 60, // 1 minute
} as const;
