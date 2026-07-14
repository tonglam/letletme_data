import { CacheError } from '../utils/errors';
import { logDebug, logError, logInfo } from '../utils/logger';
import { getActiveCacheSeason } from './cache-season';
import { redisSingleton } from './singleton';

import type { DbEntryInfo } from '../db/schemas/index.schema';

// ================================
// Hash-based Cache Operations for Entry Infos
// ================================

/**
 * Entry info cache operations using Redis Hashes
 * Redis key: EntryInfo:2526
 * Hash fields: Entry IDs (1234567, ...) as strings
 * Hash values: Complete entry info JSON objects (all fields except createdAt/updatedAt)
 *
 * Diff-based update: when setting multiple entries, only HSET entries that changed
 * to avoid rewriting the entire hash every day.
 */

const getHashKey = async () => `EntryInfo:${await getActiveCacheSeason()}`;

/**
 * Strip createdAt/updatedAt from entry info before serializing to Redis
 */
const serializeEntryInfo = (entry: DbEntryInfo): Record<string, unknown> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt, updatedAt, ...rest } = entry as DbEntryInfo & {
    createdAt?: Date;
    updatedAt?: Date;
  };
  return rest;
};

export const entryInfosCache = {
  /**
   * Set a single entry in the hash (called after each syncEntryInfo)
   */
  async setEntry(entry: DbEntryInfo): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();
      const value = JSON.stringify(serializeEntryInfo(entry));

      await redis.hset(key, entry.id.toString(), value);
      logDebug('Entry info cache set', { entryId: entry.id, key });
    } catch (error) {
      logError('Entry info cache set error', error, { entryId: entry.id });
      throw new CacheError(
        `Failed to set entry info in cache: ${entry.id}`,
        'ENTRY_INFO_SET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  /**
   * Set multiple entries with diff-based update
   * 1. HGETALL existing hash
   * 2. Compare each entry with existing data
   * 3. Only HSET entries that changed
   */
  async setEntries(
    entries: DbEntryInfo[],
  ): Promise<{ added: number; updated: number; skipped: number }> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();

      // Read existing hash
      const existingHash = await redis.hgetall(key);
      const existingMap = new Map<string, string>();
      for (const [field, value] of Object.entries(existingHash)) {
        existingMap.set(field, value);
      }

      const toSet: Record<string, string> = {};
      let added = 0;
      let updated = 0;
      let skipped = 0;

      for (const entry of entries) {
        const fieldKey = entry.id.toString();
        const newValue = JSON.stringify(serializeEntryInfo(entry));
        const existingValue = existingMap.get(fieldKey);

        if (!existingValue) {
          // New entry
          toSet[fieldKey] = newValue;
          added++;
        } else if (existingValue !== newValue) {
          // Changed entry
          toSet[fieldKey] = newValue;
          updated++;
        } else {
          // Unchanged - skip
          skipped++;
        }
      }

      if (Object.keys(toSet).length > 0) {
        await redis.hset(key, toSet);
      }

      logInfo('Entry infos cache diff update', {
        key,
        added,
        updated,
        skipped,
        totalProcessed: entries.length,
        totalChanged: Object.keys(toSet).length,
      });

      return { added, updated, skipped };
    } catch (error) {
      logError('Entry infos cache batch set error', error, { count: entries.length });
      throw new CacheError(
        'Failed to set entry infos in cache',
        'ENTRY_INFOS_BATCH_SET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  /**
   * Get a single entry by ID from the hash
   */
  async getEntry(entryId: number): Promise<DbEntryInfo | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();
      const value = await redis.hget(key, entryId.toString());

      if (!value) {
        logDebug('Entry info cache miss', { entryId, key });
        return null;
      }

      const parsed = JSON.parse(value) as DbEntryInfo;
      logDebug('Entry info cache hit', { entryId, key });
      return parsed;
    } catch (error) {
      logError('Entry info cache get error', error, { entryId });
      throw new CacheError(
        `Failed to get entry info from cache: ${entryId}`,
        'ENTRY_INFO_GET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  /**
   * Get multiple entries by IDs from the hash
   * Returns a Map of entryId -> DbEntryInfo for found entries
   */
  async getEntries(entryIds: number[]): Promise<Map<number, DbEntryInfo>> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();

      const results = new Map<number, DbEntryInfo>();
      if (entryIds.length === 0) {
        return results;
      }

      // HMGET supports multiple fields in one call
      const values = await redis.hmget(key, ...entryIds.map(String));

      for (let i = 0; i < entryIds.length; i++) {
        const value = values[i];
        if (value) {
          const parsed = JSON.parse(value) as DbEntryInfo;
          results.set(entryIds[i], parsed);
        }
      }

      const foundCount = results.size;
      const missCount = entryIds.length - foundCount;
      logDebug('Entry infos cache multi-get', {
        key,
        requested: entryIds.length,
        found: foundCount,
        missed: missCount,
      });

      return results;
    } catch (error) {
      logError('Entry infos cache multi-get error', error, { count: entryIds.length });
      throw new CacheError(
        'Failed to get entry infos from cache',
        'ENTRY_INFOS_MULTI_GET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  /**
   * Get all entries from the hash
   */
  async getAll(): Promise<DbEntryInfo[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Entry infos cache miss (all)', { key });
        return null;
      }

      const entries = Object.values(hash).map((value) => JSON.parse(value) as DbEntryInfo);
      logDebug('Entry infos cache hit (all)', { key, count: entries.length });
      return entries;
    } catch (error) {
      logError('Entry infos cache get all error', error);
      throw new CacheError(
        'Failed to get all entry infos from cache',
        'ENTRY_INFOS_GET_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  /**
   * Clear all entry info cache data
   */
  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = await getHashKey();
      await redis.del(key);
      logDebug('Entry infos cache cleared', { key });
    } catch (error) {
      logError('Entry infos cache clear error', error);
      throw new CacheError(
        'Failed to clear entry infos cache',
        'ENTRY_INFOS_CLEAR_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },
};
