import { QueueConnection } from '../../infrastructures/queue/types';

// Base Redis configuration
const BASE_REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
} as const;

// Queue-specific Redis configuration
export const REDIS_CONFIG: QueueConnection = {
  host: BASE_REDIS_CONFIG.host,
  port: BASE_REDIS_CONFIG.port,
  password: BASE_REDIS_CONFIG.password,
};

// Different prefixes for different use cases
export const REDIS_KEY_PREFIXES = {
  CACHE: 'cache:',
  QUEUE: 'queue:',
  LOCK: 'lock:',
} as const;

// TTL configurations
export const REDIS_TTL = {
  CACHE: {
    DEFAULT: 60 * 60, // 1 hour
    SHORT: 5 * 60, // 5 minutes
    MEDIUM: 30 * 60, // 30 minutes
    LONG: 24 * 60 * 60, // 24 hours
  },
} as const;
