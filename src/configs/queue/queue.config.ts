import { JobStatus } from '../../types/queue.type';
import { REDIS_CONFIG, REDIS_KEY_PREFIXES } from '../redis/redis.config';

/**
 * Queue configuration interface
 */
export interface QueueConfig {
  readonly name: string;
  readonly prefix: string;
  readonly connection: typeof REDIS_CONFIG;
}

/**
 * Queue cleanup options interface
 */
export interface QueueCleanupOptions {
  readonly age?: number;
  readonly limit?: number;
  readonly status?: JobStatus;
}

/**
 * Queue configuration constants
 */
export const QUEUE_CONSTANTS = {
  PRIORITIES: {
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  },
  ATTEMPTS: {
    HIGH: 5,
    MEDIUM: 3,
    LOW: 1,
  },
  BACKOFF: {
    TYPE: 'exponential' as const,
    DELAY: 1000, // 1 second
  },
  CLEANUP: {
    AGE: 24 * 60 * 60 * 1000, // 24 hours
    LIMIT: 1000,
  },
  LOCK_DURATION: 30000, // 30 seconds
} as const;

/**
 * Job schedule patterns (cron expressions)
 */
export const JOB_SCHEDULES = {
  // Meta jobs
  META_UPDATE: '35 6 * * *', // 6:35 AM UTC daily

  // Live jobs
  LIVE_UPDATE: '*/1 * * * *', // Every minute

  // Post-match jobs
  POST_MATCH_UPDATE: '*/5 * * * *', // Every 5 minutes

  // Post-gameweek jobs
  POST_GAMEWEEK_UPDATE: '0 */6 * * *', // Every 6 hours

  // Daily jobs
  DAILY_UPDATE: '0 0 * * *', // Midnight UTC
} as const;

/**
 * Queue names
 */
export const QUEUE_NAMES = {
  META: 'meta',
  LIVE: 'live',
  POST_MATCH: 'post-match',
  POST_GAMEWEEK: 'post-gameweek',
  DAILY: 'daily',
} as const;

/**
 * Queue configuration factory
 */
export const createQueueConfig = (queueName: string): QueueConfig => ({
  name: queueName,
  prefix: REDIS_KEY_PREFIXES.QUEUE,
  connection: REDIS_CONFIG,
});