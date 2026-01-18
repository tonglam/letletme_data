import { getCurrentSeason } from '../utils/conditions';
import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { PlayerStat } from '../domain/player-stats';
import type { EventId } from '../types/base.type';

const getHashKey = (): string => {
  return `PlayerStat:${getCurrentSeason()}`;
};

export const createPlayerStatsHashCache = () => {
  return {
    getPlayerStatsByEvent: async (eventId: EventId): Promise<PlayerStat[] | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) {
          logDebug('Player stats cache miss by event', { eventId, key });
          return null;
        }

        const playerStats = Object.values(hash)
          .map((value) => JSON.parse(value) as PlayerStat)
          .filter((stat) => stat.eventId === eventId);

        if (playerStats.length === 0) {
          logDebug('Player stats cache miss by event (no matching event ID)', { eventId, key });
          return null;
        }

        logDebug('Player stats cache hit by event', {
          eventId,
          key,
          count: playerStats.length,
        });
        return playerStats;
      } catch (error) {
        logError('Player stats cache get by event error', error, { eventId });
        throw new CacheError(
          `Failed to get player stats from cache for event: ${eventId}`,
          'PLAYER_STATS_GET_BY_EVENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    setPlayerStatsByEvent: async (eventId: EventId, playerStats: PlayerStat[]): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();

        const hashEntries: Record<string, string> = {};
        for (const playerStat of playerStats) {
          if (playerStat.elementId) {
            hashEntries[String(playerStat.elementId)] = JSON.stringify(playerStat);
          }
        }

        const pipeline = redis.pipeline();
        pipeline.del(key);

        if (Object.keys(hashEntries).length === 0) {
          await pipeline.exec();
          logDebug('Player stats cache cleared (no entries to set)', { key, eventId });
          return;
        }

        pipeline.hset(key, hashEntries);
        pipeline.expire(key, CACHE_TTL.PLAYER_STATS);

        await pipeline.exec();
        logDebug('Player stats cache batch set by event', {
          key,
          eventId,
          count: playerStats.length,
          elementIds: Object.keys(hashEntries).slice(0, 5),
        });
      } catch (error) {
        logError('Player stats cache batch set by event error', error, {
          eventId,
          count: playerStats.length,
        });
        throw new CacheError(
          `Failed to set player stats in cache for event: ${eventId}`,
          'PLAYER_STATS_SET_BY_EVENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    clearByEvent: async (eventId: EventId): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();

        await redis.del(key);
        logDebug('Player stats cache cleared by event', { eventId, key });
      } catch (error) {
        logError('Player stats cache clear by event error', error, { eventId });
        throw new CacheError(
          `Failed to clear player stats cache for event: ${eventId}`,
          'PLAYER_STATS_CLEAR_BY_EVENT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    clearAll: async (): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
        await redis.del(key);
        logDebug('All player stats cache cleared', { key });
      } catch (error) {
        logError('Player stats cache clear all error', error);
        throw new CacheError(
          'Failed to clear all player stats cache',
          'PLAYER_STATS_CLEAR_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    getLatestEventId: async (): Promise<EventId | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) return null;

        const firstPlayerStat = JSON.parse(Object.values(hash)[0]);
        return firstPlayerStat.eventId;
      } catch (error) {
        logError('Player stats cache get latest event id error', error);
        return null;
      }
    },
  };
};

const playerStatsHashCacheInstance = createPlayerStatsHashCache();

export const playerStatsCache = {
  async getByEvent(eventId: EventId): Promise<PlayerStat[] | null> {
    return playerStatsHashCacheInstance.getPlayerStatsByEvent(eventId);
  },

  async setByEvent(eventId: EventId, playerStats: PlayerStat[]): Promise<void> {
    return playerStatsHashCacheInstance.setPlayerStatsByEvent(eventId, playerStats);
  },

  async clearAll(): Promise<void> {
    return playerStatsHashCacheInstance.clearAll();
  },

  async clearByEvent(eventId: EventId): Promise<void> {
    return playerStatsHashCacheInstance.clearByEvent(eventId);
  },
};
