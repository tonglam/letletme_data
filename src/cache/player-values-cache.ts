import { logDebug, logError } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { PlayerValue } from '../domain/player-values';

export const playerValuesCache = {
  // Store player values by changeDate: PlayerValue:{changeDate}
  // Replaces the whole hash (use after a full re-read of the date, or clear).
  async set(changeDate: string, playerValues: PlayerValue[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue:${changeDate}`;
      // PlayerValueMissing:* is written by an external consumer; delete it here
      // defensively whenever we refresh the real PlayerValue hash for that date.
      const missingKey = `PlayerValueMissing:${changeDate}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key, missingKey);

      if (playerValues.length > 0) {
        // Store each player value as a hash field (element ID -> full player value JSON)
        const valueFields: Record<string, string> = {};
        for (const playerValue of playerValues) {
          valueFields[playerValue.elementId.toString()] = JSON.stringify(playerValue);
        }
        pipeline.hset(key, valueFields);
      }

      await pipeline.exec();
      logDebug('Player values cache updated (hash)', { count: playerValues.length, changeDate });
    } catch (error) {
      logError('Player values cache set error', error);
      throw error;
    }
  },

  /**
   * Merge fields into PlayerValue:{date} without deleting the existing hash.
   * Used after partial ON CONFLICT DO NOTHING inserts so concurrent daily syncs
   * do not erase each other's winners (FP-10 Codex P2).
   */
  async merge(changeDate: string, playerValues: PlayerValue[]): Promise<void> {
    try {
      if (playerValues.length === 0) {
        return;
      }
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue:${changeDate}`;
      const missingKey = `PlayerValueMissing:${changeDate}`;
      const valueFields: Record<string, string> = {};
      for (const playerValue of playerValues) {
        valueFields[playerValue.elementId.toString()] = JSON.stringify(playerValue);
      }
      const pipeline = redis.pipeline();
      pipeline.del(missingKey);
      pipeline.hset(key, valueFields);
      await pipeline.exec();
      logDebug('Player values cache merged (hash fields)', {
        count: playerValues.length,
        changeDate,
      });
    } catch (error) {
      logError('Player values cache merge error', error);
      throw error;
    }
  },

  async get(changeDate: string): Promise<PlayerValue[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue:${changeDate}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Player values cache miss', { changeDate });
        return null;
      }

      const values = Object.values(hash).map((value) => JSON.parse(value) as PlayerValue);
      logDebug('Player values cache hit', { count: values.length, changeDate });
      return values;
    } catch (error) {
      logError('Player values cache get error', error);
      return null;
    }
  },

  async clear(changeDate: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue:${changeDate}`;
      const missingKey = `PlayerValueMissing:${changeDate}`;
      await redis.del(key, missingKey);
      logDebug('Player values cache cleared', { changeDate });
    } catch (error) {
      logError('Player values cache clear error', error);
      throw error;
    }
  },
};
