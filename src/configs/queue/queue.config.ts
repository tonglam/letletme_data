export const QUEUE_CONFIG = {
  MAX_ATTEMPTS: 3,
  INITIAL_BACKOFF: 1000, // 1 second
  MAX_BACKOFF: 30000, // 30 seconds
  JOB_TIMEOUT: 30000, // 30 seconds
  CONCURRENCY: 2,
  RATE_LIMIT: {
    MAX: 5,
    DURATION: 1000, // 1 second
  },
  STALLED_CHECK_INTERVAL: 30000, // 30 seconds
  RETENTION: {
    COUNT: 100,
    AGE: 24 * 60 * 60 * 1000, // 24 hours
  },
} as const;
