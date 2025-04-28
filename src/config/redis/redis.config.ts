export const REDIS_KEY_PREFIXES = {
  CACHE: 'cache:',
  QUEUE: 'queue:',
  LOCK: 'lock:',
} as const;

export const REDIS_TTL = {
  CACHE: {
    DEFAULT: 60 * 60, // 1 hour
    SHORT: 5 * 60, // 5 minutes
    MEDIUM: 30 * 60, // 30 minutes
    LONG: 24 * 60 * 60, // 24 hours
  },
} as const;
