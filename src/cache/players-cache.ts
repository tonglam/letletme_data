import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { finalizeSeasonCacheWrite, getActiveCacheSeason } from './cache-season';
import { parseHashValues } from './hash-read';
import { redisSingleton } from './singleton';

import type { Player } from '../types';

// ================================
// Hash-based Cache Operations for Players
// ================================

/**
 * Player cache operations using Redis Hashes
 * Single key for latest player data only - no historical data
 * Redis key: Player:2526
 * Hash fields: Element IDs (1, 2, 3, ...) as strings
 * Hash values: Complete player JSON objects (latest version only)
 * When new player data comes in, replace entire cache
 */

const getHashKey = async (season?: string) => `Player:${season ?? (await getActiveCacheSeason())}`;

/**
 * Validate the complete roster and apply price-only patches in one Redis
 * command. Redis serializes scripts with MULTI roster replacement, so a price
 * job can run either before or after a replacement but can never write stale
 * full player objects across it.
 */
const MERGE_PLAYER_PRICES_SCRIPT = `
local expected_count = tonumber(ARGV[1])
local update_count = tonumber(ARGV[2])

if redis.call('HLEN', KEYS[1]) ~= expected_count then
  return -1
end

for index = 1, expected_count do
  if redis.call('HEXISTS', KEYS[1], ARGV[2 + index]) ~= 1 then
    return -1
  end
end

local update_offset = 2 + expected_count
local decoded_updates = {}
for index = 1, update_count do
  local argument_offset = update_offset + ((index - 1) * 2)
  local element_id = ARGV[argument_offset + 1]
  local price = tonumber(ARGV[argument_offset + 2])
  local raw = redis.call('HGET', KEYS[1], element_id)
  if raw == false then
    return -1
  end
  local decoded, player = pcall(cjson.decode, raw)
  if not decoded
    or type(player) ~= 'table'
    or tonumber(player.id) ~= tonumber(element_id)
    or price == nil
  then
    return -2
  end
  player.price = price
  decoded_updates[index] = { element_id, cjson.encode(player) }
end

for index = 1, update_count do
  redis.call('HSET', KEYS[1], decoded_updates[index][1], decoded_updates[index][2])
end

return update_count
`;

export interface PlayerPriceCacheUpdate {
  elementId: number;
  value: number;
}

const createPlayerHashCache = () => {
  return {
    /**
     * Get a single player by element ID from the hash
     */
    getPlayer: async (playerId: number): Promise<Player | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();
        const value = await redis.hget(key, playerId.toString());

        if (!value) {
          logDebug('Player cache miss', { playerId, key });
          return null;
        }

        const parsed = JSON.parse(value);
        logDebug('Player cache hit', { playerId, key });
        return parsed;
      } catch (error) {
        logError('Player cache get error', error, { playerId });
        return null;
      }
    },

    /**
     * Set a single player in the hash using element ID as field key
     */
    setPlayer: async (playerId: number, player: Player): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();
        const serialized = JSON.stringify(player);

        await redis.hset(key, playerId.toString(), serialized);

        logDebug('Player cache set', { playerId, key });
      } catch (error) {
        logError('Player cache set error', error, { playerId });
        throw new CacheError(
          `Failed to set player in cache: ${playerId}`,
          'PLAYER_SET_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Get all players from the hash (Player:2526 -> {elementId: playerObject})
     */
    getAllPlayers: async (season?: string): Promise<Player[] | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey(season);
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) {
          logDebug('Players cache miss', { key });
          return null;
        }

        const players = parseHashValues<Player>(hash, { key });
        logDebug('Players cache hit', {
          key,
          count: players.length,
        });
        return players;
      } catch (error) {
        logError('Players cache get all error', error);
        return null;
      }
    },

    /**
     * Set multiple players in the hash (batch operation)
     * Hash structure: Player:2526 -> {elementId: playerObject}
     * Hash field keys: Element IDs (1, 2, 3, ...) as strings
     * Hash field values: Complete player JSON objects
     */
    setAllPlayers: async (players: Player[], season?: string): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const activeSeason = season ?? (await getActiveCacheSeason());
        const key = await getHashKey(activeSeason);

        // Create hash entries using element ID as hash field key
        const hashEntries: Record<string, string> = {};
        for (const player of players) {
          if (player.id) {
            // Hash field key: Element ID (player.id is the FPL element ID: 1, 2, 3, ...)
            // Hash field value: Complete player object as JSON
            hashEntries[String(player.id)] = JSON.stringify(player);
          }
        }

        // Redis MULTI keeps readers on either the complete old roster or the
        // complete new roster; a pipeline alone does not provide isolation.
        const transaction = redis.multi().del(key);

        if (Object.keys(hashEntries).length === 0) {
          const results = await transaction.exec();
          if (!results) throw new Error(`Players cache transaction aborted for ${key}`);
          const commandError = results.find(([error]) => error !== null)?.[0];
          if (commandError) throw commandError;
          logDebug('Players cache cleared (no entries to set)', { key });
          return;
        }

        // Set all players in single hash operation
        transaction.hset(key, hashEntries);

        // No metadata key needed

        const results = await transaction.exec();
        if (!results) throw new Error(`Players cache transaction aborted for ${key}`);
        const commandError = results.find(([error]) => error !== null)?.[0];
        if (commandError) throw commandError;
        await finalizeSeasonCacheWrite(activeSeason, ['Player']);
        logDebug('Players cache batch set', {
          key,
          count: players.length,
          elementIds: Object.keys(hashEntries).slice(0, 5), // Show first 5 element IDs
        });
      } catch (error) {
        logError('Players cache batch set error', error, { count: players.length });
        throw new CacheError(
          'Failed to set all players in cache',
          'PLAYERS_SET_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Patch only current prices after atomically verifying that Redis still
     * contains the exact published roster. Identity fields always come from
     * the current cache value, never from a potentially stale price worker.
     */
    mergePlayerPrices: async (
      updates: PlayerPriceCacheUpdate[],
      expectedPlayerIds: number[],
      season?: string,
    ): Promise<void> => {
      if (updates.length === 0) {
        return;
      }

      try {
        const key = await getHashKey(season);
        const redis = await redisSingleton.getClient();
        const expectedIds = [...new Set(expectedPlayerIds)]
          .filter((elementId) => Number.isInteger(elementId) && elementId > 0)
          .sort((left, right) => left - right);
        if (expectedIds.length !== expectedPlayerIds.length) {
          throw new CacheError(
            `Refusing to merge prices with invalid expected player IDs: ${key}`,
            'PLAYERS_MERGE_INVALID_EXPECTED_IDS',
          );
        }
        const expectedIdSet = new Set(expectedIds);
        const normalizedUpdates = updates.map(({ elementId, value }) => ({ elementId, value }));
        if (
          normalizedUpdates.some(
            ({ elementId, value }) =>
              !Number.isInteger(elementId) ||
              elementId <= 0 ||
              !Number.isInteger(value) ||
              value <= 0 ||
              !expectedIdSet.has(elementId),
          ) ||
          new Set(normalizedUpdates.map(({ elementId }) => elementId)).size !==
            normalizedUpdates.length
        ) {
          throw new CacheError(
            `Refusing to merge invalid player price updates: ${key}`,
            'PLAYERS_MERGE_INVALID_UPDATES',
          );
        }

        const result = Number(
          await redis.eval(
            MERGE_PLAYER_PRICES_SCRIPT,
            1,
            key,
            String(expectedIds.length),
            String(normalizedUpdates.length),
            ...expectedIds.map(String),
            ...normalizedUpdates.flatMap(({ elementId, value }) => [
              String(elementId),
              String(value),
            ]),
          ),
        );
        if (result === -1) {
          throw new CacheError(
            `Refusing to merge prices into incomplete players cache: ${key}`,
            'PLAYERS_MERGE_INCOMPLETE_VIEW',
          );
        }
        if (result === -2) {
          throw new CacheError(
            `Refusing to merge prices into malformed players cache: ${key}`,
            'PLAYERS_MERGE_INVALID_VIEW',
          );
        }
        if (result !== normalizedUpdates.length) {
          throw new Error(`Unexpected player price merge result for ${key}: ${String(result)}`);
        }
        logDebug('Player cache prices atomically merged', {
          key,
          count: normalizedUpdates.length,
        });
      } catch (error) {
        logError('Players cache merge error', error, { count: updates.length });
        if (error instanceof CacheError) {
          throw error;
        }
        throw new CacheError(
          'Failed to merge players in cache',
          'PLAYERS_MERGE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Get players by team ID
     */
    getPlayersByTeam: async (
      teamId: number,
      getAllPlayersFn: () => Promise<Player[] | null>,
    ): Promise<Player[] | null> => {
      try {
        const allPlayers = await getAllPlayersFn();
        if (!allPlayers) return null;

        const teamPlayers = allPlayers.filter((player) => player.teamId === teamId);
        logDebug('Players by team cache hit', { teamId, count: teamPlayers.length });
        return teamPlayers;
      } catch (error) {
        logError('Players by team cache error', error, { teamId });
        return null; // Graceful fallback
      }
    },

    /**
     * Get players by position
     */
    getPlayersByPosition: async (
      position: number,
      getAllPlayersFn: () => Promise<Player[] | null>,
    ): Promise<Player[] | null> => {
      try {
        const allPlayers = await getAllPlayersFn();
        if (!allPlayers) return null;

        const positionPlayers = allPlayers.filter((player) => player.type === position);
        logDebug('Players by position cache hit', { position, count: positionPlayers.length });
        return positionPlayers;
      } catch (error) {
        logError('Players by position cache error', error, { position });
        return null; // Graceful fallback
      }
    },

    /**
     * Clear all player cache data
     */
    clear: async (): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();

        await redis.del(key);
        logDebug('Players cache cleared', { key });
      } catch (error) {
        logError('Players cache clear error', error);
        throw new CacheError(
          'Failed to clear players cache',
          'PLAYERS_CLEAR_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Check if player cache exists and has data
     */
    exists: async (): Promise<boolean> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = await getHashKey();
        const result = await redis.exists(key);
        return result === 1;
      } catch (error) {
        logError('Players cache exists error', error);
        return false;
      }
    },
  };
};

/**
 * Player cache instance with hash-based operations
 */
const playerHashCacheInstance = createPlayerHashCache();

export const playersCache = {
  async get(season?: string): Promise<Player[] | null> {
    return playerHashCacheInstance.getAllPlayers(season);
  },

  async set(players: Player[], season?: string): Promise<void> {
    return playerHashCacheInstance.setAllPlayers(players, season);
  },

  async mergePrices(
    updates: PlayerPriceCacheUpdate[],
    expectedPlayerIds: number[],
    season?: string,
  ): Promise<void> {
    return playerHashCacheInstance.mergePlayerPrices(updates, expectedPlayerIds, season);
  },

  async clear(): Promise<void> {
    return playerHashCacheInstance.clear();
  },
};
