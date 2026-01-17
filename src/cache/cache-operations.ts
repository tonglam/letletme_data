import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { DEFAULT_CACHE_CONFIG, redisSingleton } from './singleton';

const getKey = (key: string): string => {
  return `${DEFAULT_CACHE_CONFIG.prefix}${key}`;
};

export type CacheOperations = {
  get: <T>(key: string) => Promise<T | null>;
  set: <T>(key: string, value: T, ttl?: number) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
};

export const createCacheOperations = (): CacheOperations => {
  return {
    get: async <T>(key: string): Promise<T | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const fullKey = getKey(key);
        const value = await redis.get(fullKey);

        if (!value) {
          logDebug('Cache miss', { key: fullKey });
          return null;
        }

        const parsed = JSON.parse(value) as T;
        logDebug('Cache hit', { key: fullKey });
        return parsed;
      } catch (error) {
        logError('Cache get error', error, { key });
        throw new CacheError(
          `Failed to get cache key: ${key}`,
          'GET_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    set: async <T>(
      key: string,
      value: T,
      ttl: number = DEFAULT_CACHE_CONFIG.ttl,
    ): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const fullKey = getKey(key);
        const serialized = JSON.stringify(value);

        await redis.setex(fullKey, ttl, serialized);
        logDebug('Cache set', { key: fullKey, ttl });
      } catch (error) {
        logError('Cache set error', error, { key, ttl });
        throw new CacheError(
          `Failed to set cache key: ${key}`,
          'SET_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    exists: async (key: string): Promise<boolean> => {
      try {
        const redis = await redisSingleton.getClient();
        const fullKey = getKey(key);
        const result = await redis.exists(fullKey);
        return result === 1;
      } catch (error) {
        logError('Cache exists error', error, { key });
        throw new CacheError(
          `Failed to check cache key existence: ${key}`,
          'EXISTS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const cache = createCacheOperations();
