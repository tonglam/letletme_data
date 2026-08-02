import { logDebug, logError } from '../utils/logger';
import { parseHashValues } from './hash-read';
import { redisSingleton } from './singleton';

import type { PlayerValue } from '../domain/player-values';

export const playerValuesCache = {
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
      // HSET first so a WRONGTYPE/OOM/network failure leaves the negative
      // marker intact and rejects the job. The marker is cleared only after
      // positive history fields were successfully written.
      await redis.hset(key, valueFields);
      await redis.del(missingKey);
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

      const values = parseHashValues<PlayerValue>(hash, { key, changeDate });
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
