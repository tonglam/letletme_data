import { randomUUID } from 'crypto';

import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { getActiveCacheSeason } from './cache-season';
import { parseHashValues } from './hash-read';
import { redisSingleton } from './singleton';

import type { PlayerStat } from '../domain/player-stats';
import type { EventId } from '../types/base.type';

const getHashKey = async (): Promise<string> => {
  return `PlayerStat:${await getActiveCacheSeason()}`;
};

export const createPlayerStatsHashCache = () => {
  return {
    getPlayerStatsByEvent: async (eventId: EventId): Promise<PlayerStat[] | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) {
          logDebug('Player stats cache miss by event', { eventId, key });
          return null;
        }

        const playerStats = parseHashValues<PlayerStat>(hash, { eventId, key }).filter(
          (stat) => stat.eventId === eventId,
        );

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
        return null;
      }
    },

    setPlayerStatsByEvent: async (eventId: EventId, playerStats: PlayerStat[]): Promise<void> => {
      if (playerStats.length === 0) {
        throw new CacheError(
          `Refusing to publish an empty player stats view for event: ${eventId}`,
          'PLAYER_STATS_EMPTY_VIEW_ERROR',
        );
      }

      let stagingKey: string | null = null;
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();
        stagingKey = `${key}:staging:${randomUUID()}`;

        const hashEntries: Record<string, string> = {};
        for (const playerStat of playerStats) {
          if (playerStat.elementId) {
            hashEntries[String(playerStat.elementId)] = JSON.stringify(playerStat);
          }
        }

        const expectedFields = Object.keys(hashEntries).length;
        if (expectedFields !== playerStats.length) {
          throw new Error('Player stats contain duplicate element IDs');
        }

        // Build a complete staging hash, verify it, then atomically rename it
        // over the latest view. Readers see either the old complete view or
        // the new complete view, never a delete/rebuild gap.
        await redis.hset(stagingKey, hashEntries);
        const stagedFields = await redis.hlen(stagingKey);
        if (stagedFields !== expectedFields) {
          throw new Error(
            `Incomplete player stats staging hash: expected ${expectedFields}, got ${stagedFields}`,
          );
        }
        await redis.rename(stagingKey, key);
        stagingKey = null;
        logDebug('Player stats cache batch set by event', {
          key,
          eventId,
          count: playerStats.length,
          elementIds: Object.keys(hashEntries).slice(0, 5),
        });
      } catch (error) {
        if (stagingKey) {
          try {
            const redis = await redisSingleton.getClient();
            await redis.del(stagingKey);
          } catch {
            // Preserve the original publication failure.
          }
        }
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

    /**
     * Despite the name, this deletes the ENTIRE PlayerStat:{season} hash —
     * the view holds only the latest synced event, so there is no per-event
     * subset to clear. The eventId argument is accepted for call-site
     * symmetry but ignored.
     */
    clearByEvent: async (eventId: EventId): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();

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
        const key = await getHashKey();
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
        const key = await getHashKey();
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

  /**
   * Clears the whole PlayerStat:{season} view (see the implementation note —
   * eventId is ignored; this is NOT a per-event clear).
   */
  async clearByEvent(eventId: EventId): Promise<void> {
    return playerStatsHashCacheInstance.clearByEvent(eventId);
  },
};
