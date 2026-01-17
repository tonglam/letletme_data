import { getCurrentSeason } from '../utils/conditions';
import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

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

const getHashKey = () => `Player:${getCurrentSeason()}`; // Dynamic season key

const createPlayerHashCache = () => {
  return {
    /**
     * Get a single player by element ID from the hash
     */
    getPlayer: async (playerId: number): Promise<Player | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
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
        throw new CacheError(
          `Failed to get player from cache: ${playerId}`,
          'PLAYER_GET_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Set a single player in the hash using element ID as field key
     */
    setPlayer: async (playerId: number, player: Player): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
        const serialized = JSON.stringify(player);

        await redis.hset(key, playerId.toString(), serialized);

        // Set expiration on the hash key
        await redis.expire(key, CACHE_TTL.PLAYERS);

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
    getAllPlayers: async (): Promise<Player[] | null> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();
        const hash = await redis.hgetall(key);

        if (!hash || Object.keys(hash).length === 0) {
          logDebug('Players cache miss', { key });
          return null;
        }

        const players = Object.values(hash).map((value) => JSON.parse(value));
        logDebug('Players cache hit', {
          key,
          count: players.length,
        });
        return players;
      } catch (error) {
        logError('Players cache get all error', error);
        throw new CacheError(
          'Failed to get all players from cache',
          'PLAYERS_GET_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Set multiple players in the hash (batch operation)
     * Hash structure: Player:2526 -> {elementId: playerObject}
     * Hash field keys: Element IDs (1, 2, 3, ...) as strings
     * Hash field values: Complete player JSON objects
     */
    setAllPlayers: async (players: Player[]): Promise<void> => {
      try {
        const redis = await redisSingleton.getClient();
        const key = getHashKey();

        // Create hash entries using element ID as hash field key
        const hashEntries: Record<string, string> = {};
        for (const player of players) {
          if (player.id) {
            // Hash field key: Element ID (player.id is the FPL element ID: 1, 2, 3, ...)
            // Hash field value: Complete player object as JSON
            hashEntries[String(player.id)] = JSON.stringify(player);
          }
        }

        // Use pipeline for atomic operation (similar to RedisUtils.pipelineHashCache)
        const pipeline = redis.pipeline();

        // Always clear existing hash key before writing to avoid stale data
        pipeline.del(key);

        if (Object.keys(hashEntries).length === 0) {
          await pipeline.exec();
          logDebug('Players cache cleared (no entries to set)', { key });
          return;
        }

        // Set all players in single hash operation
        pipeline.hset(key, hashEntries);
        pipeline.expire(key, CACHE_TTL.PLAYERS);

        // No metadata key needed

        await pipeline.exec();
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
        const key = getHashKey();

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
        const key = getHashKey();
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
  async get(): Promise<Player[] | null> {
    return playerHashCacheInstance.getAllPlayers();
  },

  async set(players: Player[]): Promise<void> {
    return playerHashCacheInstance.setAllPlayers(players);
  },

  async clear(): Promise<void> {
    return playerHashCacheInstance.clear();
  },
};
