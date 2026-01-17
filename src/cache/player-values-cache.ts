import { logDebug, logError } from '../utils/logger';
import { DEFAULT_CACHE_CONFIG, redisSingleton } from './singleton';

import type { PlayerValue } from '../domain/player-values';

const getDateKey = (changeDate: string): string => {
  return `${DEFAULT_CACHE_CONFIG.prefix}PlayerValue:${changeDate}`;
};

export type PlayerValuesHashCache = ReturnType<typeof createPlayerValuesHashCache>;

export const createPlayerValuesHashCache = () => {
  return {
    getByDate: async (changeDate: string): Promise<PlayerValue[] | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getDateKey(changeDate);
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) {
          logDebug('Player values cache miss', { changeDate });
          return null;
        }

        return Object.values(hash).map((value) => JSON.parse(value) as PlayerValue);
      } catch (error) {
        logError('Failed to get cached player values by date', error, { changeDate });
        return null;
      }
    },

    setByDate: async (changeDate: string, playerValues: PlayerValue[]): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getDateKey(changeDate);

        const entries: Record<string, string> = {};
        for (const playerValue of playerValues) {
          entries[playerValue.elementId.toString()] = JSON.stringify(playerValue);
        }

        await redis.del(key);
        if (Object.keys(entries).length === 0) {
          return;
        }

        await redis.hset(key, entries);
        await redis.expire(key, DEFAULT_CACHE_CONFIG.ttl);
      } catch (error) {
        logError('Failed to cache player values by date', error, {
          changeDate,
          count: playerValues.length,
        });
        throw error;
      }
    },

    clearByDate: async (changeDate: string): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        await redis.del(getDateKey(changeDate));
      } catch (error) {
        logError('Failed to clear cached player values by date', error, { changeDate });
      }
    },
  };
};

const playerValuesHashCacheInstance = createPlayerValuesHashCache();

export const playerValuesCache = {
  getByDate(changeDate: string) {
    return playerValuesHashCacheInstance.getByDate(changeDate);
  },
  setByDate(changeDate: string, values: PlayerValue[]) {
    return playerValuesHashCacheInstance.setByDate(changeDate, values);
  },
  clearByDate(changeDate: string) {
    return playerValuesHashCacheInstance.clearByDate(changeDate);
  },
};
