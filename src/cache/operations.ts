import { getCurrentSeason } from '../utils/conditions';
import { CacheError } from '../utils/errors';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, DEFAULT_CACHE_CONFIG, redisSingleton } from './singleton';

import type { PlayerStat } from '../domain/player-stats';
import type { Event, Phase, Player, RawFPLEvent, Team } from '../types';
import type { ElementTypeId, EventId, PlayerId, TeamId } from '../types/base.type';

export class CacheOperations {
  private getKey(key: string): string {
    return `${DEFAULT_CACHE_CONFIG.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const redis = await redisSingleton.getClient();
      const fullKey = this.getKey(key);
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
  }

  async set<T>(key: string, value: T, ttl: number = DEFAULT_CACHE_CONFIG.ttl): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const fullKey = this.getKey(key);
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
  }

  async del(key: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const fullKey = this.getKey(key);
      await redis.del(fullKey);
      logDebug('Cache delete', { key: fullKey });
    } catch (error) {
      logError('Cache delete error', error, { key });
      throw new CacheError(
        `Failed to delete cache key: ${key}`,
        'DELETE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const redis = await redisSingleton.getClient();
      const fullKey = this.getKey(key);
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
  }

  async setMultiple<T>(entries: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const pipeline = redis.pipeline();

      for (const entry of entries) {
        const fullKey = this.getKey(entry.key);
        const serialized = JSON.stringify(entry.value);
        const ttl = entry.ttl || DEFAULT_CACHE_CONFIG.ttl;
        pipeline.setex(fullKey, ttl, serialized);
      }

      await pipeline.exec();
      logDebug('Cache batch set', { count: entries.length });
    } catch (error) {
      logError('Cache batch set error', error, { count: entries.length });
      throw new CacheError(
        'Failed to set multiple cache keys',
        'BATCH_SET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async flush(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const pattern = this.getKey('*');
      const keys = await redis.keys(pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
        logDebug('Cache flushed', { deletedKeys: keys.length });
      }
    } catch (error) {
      logError('Cache flush error', error);
      throw new CacheError(
        'Failed to flush cache',
        'FLUSH_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const cache = new CacheOperations();

// Cache types for simplified Redis data structures (matching Java pattern)
interface EventCacheData {
  id: number;
  deadlineTime: string;
}

interface TeamCacheData {
  id: number;
  name: string;
  shortName: string;
}

// Domain-specific cache operations following Entity::season::field pattern
export const eventsCache = {
  async get(): Promise<EventCacheData[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Event:${getCurrentSeason()}`;

      const hash = await redis.hgetall(key);
      if (!hash || Object.keys(hash).length === 0) return null;

      // Convert hash back to event objects with deadline times
      const events = [];
      for (const [eventId, deadlineTime] of Object.entries(hash)) {
        events.push({
          id: parseInt(eventId),
          deadlineTime: deadlineTime,
        });
      }

      // Sort events by ID
      events.sort((a, b) => a.id - b.id);
      return events;
    } catch (error) {
      logError('Events cache get error', error);
      return null;
    }
  },

  async set(events: Event[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();

      // Event:season -> {eventId: deadlineTime} (matching Java pattern)
      const eventKey = `Event:${getCurrentSeason()}`;
      await redis.del(eventKey);

      if (events.length > 0) {
        const eventFields: Record<string, string> = {};
        for (const event of events) {
          // Store only deadline time, not full object (matching Java: o.getDeadlineTime())
          const deadlineTime =
            event.deadlineTime instanceof Date
              ? event.deadlineTime.toISOString()
              : event.deadlineTime || '';
          eventFields[event.id.toString()] = deadlineTime;
        }
        await redis.hset(eventKey, eventFields);
      }

      // Set expiration
      await redis.expire(eventKey, CACHE_TTL.EVENTS);

      logDebug('Events cache updated', { eventKey, count: events.length });
    } catch (error) {
      logError('Events cache set error', error);
      throw error;
    }
  },

  async setRaw(rawEvents: RawFPLEvent[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();

      // Event:season -> {eventId: deadline_time} (raw API data matching Java pattern)
      const eventKey = `Event:${getCurrentSeason()}`;
      await redis.del(eventKey);

      if (rawEvents.length > 0) {
        const eventFields: Record<string, string> = {};
        for (const rawEvent of rawEvents) {
          // Store raw deadline_time string directly from API (matching Java: o.getDeadlineTime())
          eventFields[rawEvent.id.toString()] = rawEvent.deadline_time || '';
        }
        await redis.hset(eventKey, eventFields);
      }

      // Set expiration
      await redis.expire(eventKey, CACHE_TTL.EVENTS);

      logDebug('Events cache updated with raw deadline_time', {
        eventKey,
        count: rawEvents.length,
      });
    } catch (error) {
      logError('Events cache setRaw error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const eventKey = `Event:${getCurrentSeason()}`;
      await redis.del(eventKey);
      logDebug('Events cache cleared', { eventKey });
    } catch (error) {
      logError('Events cache clear error', error);
      throw error;
    }
  },
};

export const teamsCache = {
  async get(): Promise<TeamCacheData[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const nameKey = `Team:${season}:name`;
      const shortNameKey = `Team:${season}:shortName`;

      // Get team names and short names from both hashes
      const nameHash = await redis.hgetall(nameKey);
      const shortNameHash = await redis.hgetall(shortNameKey);

      if (!nameHash || Object.keys(nameHash).length === 0) return null;

      // Reconstruct team objects from the two hashes
      const teams = [];
      for (const [teamId, name] of Object.entries(nameHash)) {
        const shortName = shortNameHash[teamId] || '';
        teams.push({
          id: parseInt(teamId),
          name: name,
          shortName: shortName,
        });
      }

      // Sort teams by ID
      teams.sort((a, b) => a.id - b.id);
      return teams;
    } catch (error) {
      logError('Teams cache get error', error);
      return null;
    }
  },

  async set(teams: Team[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();

      // Following Java pattern: Team:season:name and Team:season:shortName
      const season = getCurrentSeason();
      const nameKey = `Team:${season}:name`;
      const shortNameKey = `Team:${season}:shortName`;

      // Clear existing data
      await redis.del(nameKey, shortNameKey);

      if (teams.length > 0) {
        // Prepare name and shortName hashes
        const nameFields: Record<string, string> = {};
        const shortNameFields: Record<string, string> = {};

        for (const team of teams) {
          nameFields[team.id.toString()] = team.name || '';
          shortNameFields[team.id.toString()] = team.shortName || '';
        }

        // Set both hashes
        await redis.hset(nameKey, nameFields);
        await redis.hset(shortNameKey, shortNameFields);

        // Set expiration on both keys
        await redis.expire(nameKey, CACHE_TTL.TEAMS);
        await redis.expire(shortNameKey, CACHE_TTL.TEAMS);
      }

      logDebug('Teams cache updated', { nameKey, shortNameKey, count: teams.length });
    } catch (error) {
      logError('Teams cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const nameKey = `Team:${season}:name`;
      const shortNameKey = `Team:${season}:shortName`;

      await redis.del(nameKey, shortNameKey);
      logDebug('Teams cache cleared', { nameKey, shortNameKey });
    } catch (error) {
      logError('Teams cache clear error', error);
      throw error;
    }
  },
};

export const phasesCache = {
  async get(): Promise<Phase[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Phase:${getCurrentSeason()}`;

      const phaseIds = await redis.hkeys(key);
      if (phaseIds.length === 0) return null;

      const phases = [];
      for (const id of phaseIds) {
        const phaseData = await redis.hget(key, id);
        if (phaseData) {
          phases.push(JSON.parse(phaseData));
        }
      }

      // Sort phases by ID to ensure consistent ordering
      phases.sort((a, b) => a.id - b.id);

      return phases.length > 0 ? phases : null;
    } catch (error) {
      logError('Phases cache get error', error);
      return null;
    }
  },

  async set(phases: Phase[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();

      // Phase:season - Full phase objects
      const phaseKey = `Phase:${getCurrentSeason()}`;
      await redis.del(phaseKey);

      for (const phase of phases) {
        // Store full phase object
        await redis.hset(phaseKey, phase.id.toString(), JSON.stringify(phase));
      }

      // Set expiration
      await redis.expire(phaseKey, CACHE_TTL.PHASES);

      logDebug('Phases cache updated', { phaseKey, count: phases.length });
    } catch (error) {
      logError('Phases cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const phaseKey = `Phase:${getCurrentSeason()}`;
      await redis.del(phaseKey);
      logDebug('Phases cache cleared', { phaseKey });
    } catch (error) {
      logError('Phases cache clear error', error);
      throw error;
    }
  },
};

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
class PlayerHashCache {
  private readonly getHashKey = () => `Player:${getCurrentSeason()}`; // Dynamic season key

  /**
   * Get a single player by element ID from the hash
   */
  async getPlayer(playerId: number): Promise<Player | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
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
  }

  /**
   * Set a single player in the hash using element ID as field key
   */
  async setPlayer(playerId: number, player: Player): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const serialized = JSON.stringify(player);

      await redis.hset(key, playerId.toString(), serialized);

      // Set expiration on the hash key
      await redis.expire(key, DEFAULT_CACHE_CONFIG.ttl);

      logDebug('Player cache set', { playerId, key });
    } catch (error) {
      logError('Player cache set error', error, { playerId });
      throw new CacheError(
        `Failed to set player in cache: ${playerId}`,
        'PLAYER_SET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get all players from the hash (Player:2526 -> {elementId: playerObject})
   */
  async getAllPlayers(): Promise<Player[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
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
  }

  /**
   * Set multiple players in the hash (batch operation)
   * Hash structure: Player:2526 -> {elementId: playerObject}
   * Hash field keys: Element IDs (1, 2, 3, ...) as strings
   * Hash field values: Complete player JSON objects
   */
  async setAllPlayers(players: Player[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();

      // Create hash entries using element ID as hash field key
      const hashEntries: Record<string, string> = {};
      for (const player of players) {
        if (player.id) {
          // Hash field key: Element ID (player.id is the FPL element ID: 1, 2, 3, ...)
          // Hash field value: Complete player object as JSON
          hashEntries[String(player.id)] = JSON.stringify(player);
        }
      }

      if (Object.keys(hashEntries).length === 0) {
        logDebug('No valid players to cache');
        return;
      }

      // Use pipeline for atomic operation (similar to RedisUtils.pipelineHashCache)
      const pipeline = redis.pipeline();

      // Clear existing hash key (similar to RedisUtils.removeCacheByKey)
      pipeline.del(key);

      // Set all players in single hash operation
      pipeline.hset(key, hashEntries);
      pipeline.expire(key, DEFAULT_CACHE_CONFIG.ttl);

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
  }

  /**
   * Get players by team ID
   */
  async getPlayersByTeam(teamId: number): Promise<Player[] | null> {
    try {
      const allPlayers = await this.getAllPlayers();
      if (!allPlayers) return null;

      const teamPlayers = allPlayers.filter((player) => player.teamId === teamId);
      logDebug('Players by team cache hit', { teamId, count: teamPlayers.length });
      return teamPlayers;
    } catch (error) {
      logError('Players by team cache error', error, { teamId });
      return null; // Graceful fallback
    }
  }

  /**
   * Get players by position
   */
  async getPlayersByPosition(position: number): Promise<Player[] | null> {
    try {
      const allPlayers = await this.getAllPlayers();
      if (!allPlayers) return null;

      const positionPlayers = allPlayers.filter((player) => player.type === position);
      logDebug('Players by position cache hit', { position, count: positionPlayers.length });
      return positionPlayers;
    } catch (error) {
      logError('Players by position cache error', error, { position });
      return null; // Graceful fallback
    }
  }

  /**
   * Clear all player cache data
   */
  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();

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
  }

  /**
   * Check if player cache exists and has data
   */
  async exists(): Promise<boolean> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      logError('Players cache exists error', error);
      return false;
    }
  }
}

/**
 * Player cache instance with hash-based operations
 */
export const playersCache = {
  private: new PlayerHashCache(),

  async get(): Promise<Player[] | null> {
    return this.private.getAllPlayers();
  },

  async set(players: Player[]): Promise<void> {
    return this.private.setAllPlayers(players);
  },

  async clear(): Promise<void> {
    return this.private.clear();
  },

  async exists(): Promise<boolean> {
    return this.private.exists();
  },

  // Extended methods for player-specific operations
  async getPlayer(playerId: number): Promise<Player | null> {
    return this.private.getPlayer(playerId);
  },

  async setPlayer(playerId: number, player: Player): Promise<void> {
    return this.private.setPlayer(playerId, player);
  },

  async getPlayersByTeam(teamId: number): Promise<Player[] | null> {
    return this.private.getPlayersByTeam(teamId);
  },

  async getPlayersByPosition(position: number): Promise<Player[] | null> {
    return this.private.getPlayersByPosition(position);
  },
};

// ================================
// Hash-based Cache Operations for Player Stats
// ================================

/**
 * Player Stats cache operations using Redis Hashes
 * Single key for latest player stats only - no historical data
 * Redis key: PlayerStat:2526
 * Hash fields: Element IDs (1, 2, 3, ...) as strings
 * Hash values: Complete player stat JSON objects (latest event only)
 * When new event data comes in, replace entire cache
 */
class PlayerStatsHashCache {
  private getHashKey(): string {
    return `PlayerStat:${getCurrentSeason()}`; // Dynamic season key for latest stats only
  }

  /**
   * Get a single player stat by player ID from the hash
   * Cache contains only latest event data, no event filtering needed
   */
  async getPlayerStat(eventId: EventId, playerId: PlayerId): Promise<PlayerStat | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const value = await redis.hget(key, playerId.toString());

      if (!value) {
        logDebug('Player stat cache miss', { eventId, playerId, key });
        return null;
      }

      const parsed = JSON.parse(value);
      logDebug('Player stat cache hit', { eventId, playerId, key });
      return parsed;
    } catch (error) {
      logError('Player stat cache get error', error, { eventId, playerId });
      throw new CacheError(
        `Failed to get player stat from cache: event ${eventId}, player ${playerId}`,
        'PLAYER_STAT_GET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Set a single player stat in the hash using element ID as field key
   * Following Java pattern: season-based key with element ID as hash field
   */
  async setPlayerStat(playerStat: PlayerStat): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const serialized = JSON.stringify(playerStat);

      await redis.hset(key, playerStat.elementId.toString(), serialized);

      // Set expiration on the hash key
      await redis.expire(key, CACHE_TTL.EVENTS); // Use same TTL as events

      logDebug('Player stat cache set', {
        eventId: playerStat.eventId,
        playerId: playerStat.elementId,
        key,
      });
    } catch (error) {
      logError('Player stat cache set error', error, {
        eventId: playerStat.eventId,
        playerId: playerStat.elementId,
      });
      throw new CacheError(
        `Failed to set player stat in cache: event ${playerStat.eventId}, player ${playerStat.elementId}`,
        'PLAYER_STAT_SET_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get all player stats for a specific event from the hash
   */
  async getPlayerStatsByEvent(eventId: EventId): Promise<PlayerStat[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Player stats cache miss by event', { eventId, key });
        return null;
      }

      const playerStats = Object.values(hash).map((value) => JSON.parse(value));
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
  }

  /**
   * Set multiple player stats for a specific event (batch operation)
   */
  async setPlayerStatsByEvent(eventId: EventId, playerStats: PlayerStat[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();

      // Create hash entries using element ID as hash field key
      const hashEntries: Record<string, string> = {};
      for (const playerStat of playerStats) {
        if (playerStat.elementId && playerStat.eventId === eventId) {
          hashEntries[String(playerStat.elementId)] = JSON.stringify(playerStat);
        }
      }

      if (Object.keys(hashEntries).length === 0) {
        logDebug('No valid player stats to cache for event', { eventId });
        return;
      }

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash key
      pipeline.del(key);

      // Set all player stats in single hash operation
      pipeline.hset(key, hashEntries);
      pipeline.expire(key, CACHE_TTL.EVENTS);

      await pipeline.exec();
      logDebug('Player stats cache batch set by event', {
        eventId,
        key,
        count: playerStats.length,
        elementIds: Object.keys(hashEntries).slice(0, 5), // Show first 5 element IDs
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
  }

  /**
   * Get player stats by team for a specific event
   */
  async getPlayerStatsByTeam(eventId: EventId, teamId: TeamId): Promise<PlayerStat[] | null> {
    try {
      const allStats = await this.getPlayerStatsByEvent(eventId);
      if (!allStats) return null;

      const teamStats = allStats.filter((stat) => stat.teamId === teamId);
      logDebug('Player stats by team cache hit', {
        eventId,
        teamId,
        count: teamStats.length,
      });
      return teamStats;
    } catch (error) {
      logError('Player stats by team cache error', error, { eventId, teamId });
      return null; // Graceful fallback
    }
  }

  /**
   * Get player stats by position for a specific event
   */
  async getPlayerStatsByPosition(
    eventId: EventId,
    elementType: ElementTypeId,
  ): Promise<PlayerStat[] | null> {
    try {
      const allStats = await this.getPlayerStatsByEvent(eventId);
      if (!allStats) return null;

      const positionStats = allStats.filter((stat) => stat.elementType === elementType);
      logDebug('Player stats by position cache hit', {
        eventId,
        elementType,
        count: positionStats.length,
      });
      return positionStats;
    } catch (error) {
      logError('Player stats by position cache error', error, { eventId, elementType });
      return null; // Graceful fallback
    }
  }

  /**
   * Clear player stats cache for a specific event
   */
  async clearByEvent(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();

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
  }

  /**
   * Clear all player stats cache data
   */
  async clearAll(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
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
  }

  /**
   * Check if player stats cache exists for an event
   */
  async existsByEvent(eventId: EventId): Promise<boolean> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const result = await redis.exists(key);
      return result === 1;
    } catch (error) {
      logError('Player stats cache exists by event error', error, { eventId });
      return false;
    }
  }

  /**
   * Get the latest cached event ID that has player stats
   */
  async getLatestEventId(): Promise<EventId | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.getHashKey();
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) return null;

      // Get event ID from any player stat (they should all be from the same event)
      const firstPlayerStat = JSON.parse(Object.values(hash)[0]);
      return firstPlayerStat.eventId;
    } catch (error) {
      logError('Player stats cache get latest event id error', error);
      return null;
    }
  }
}

/**
 * Player stats cache instance with hash-based operations
 */
export const playerStatsCache = {
  private: new PlayerStatsHashCache(),

  // Event-based operations
  async getByEvent(eventId: EventId): Promise<PlayerStat[] | null> {
    return this.private.getPlayerStatsByEvent(eventId);
  },

  async setByEvent(eventId: EventId, playerStats: PlayerStat[]): Promise<void> {
    return this.private.setPlayerStatsByEvent(eventId, playerStats);
  },

  async clearByEvent(eventId: EventId): Promise<void> {
    return this.private.clearByEvent(eventId);
  },

  async existsByEvent(eventId: EventId): Promise<boolean> {
    return this.private.existsByEvent(eventId);
  },

  // Individual player stat operations
  async getPlayerStat(eventId: EventId, playerId: PlayerId): Promise<PlayerStat | null> {
    return this.private.getPlayerStat(eventId, playerId);
  },

  async setPlayerStat(playerStat: PlayerStat): Promise<void> {
    return this.private.setPlayerStat(playerStat);
  },

  // Filtered operations
  async getByTeam(eventId: EventId, teamId: TeamId): Promise<PlayerStat[] | null> {
    return this.private.getPlayerStatsByTeam(eventId, teamId);
  },

  async getByPosition(eventId: EventId, elementType: ElementTypeId): Promise<PlayerStat[] | null> {
    return this.private.getPlayerStatsByPosition(eventId, elementType);
  },

  // Utility operations
  async clearAll(): Promise<void> {
    return this.private.clearAll();
  },

  async getLatestEventId(): Promise<EventId | null> {
    return this.private.getLatestEventId();
  },
};
