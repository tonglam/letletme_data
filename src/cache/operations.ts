import { getCurrentSeason } from '../utils/conditions';
import { CacheError } from '../utils/errors';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, DEFAULT_CACHE_CONFIG, redisSingleton } from './singleton';

import type { EventLive } from '../domain/event-lives';
import type { PlayerStat } from '../domain/player-stats';
import type { PlayerValue } from '../domain/player-values';
import type { Event, Fixture, Phase, Player, Team } from '../types';
import type { ElementTypeId, EventId, PlayerId, TeamId, ValueChangeType } from '../types/base.type';

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
  // Get all events (full objects from hash)
  async getAll(): Promise<Event[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Event:${getCurrentSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Events cache miss (all)');
        return null;
      }

      // Parse all event objects from hash
      const events = Object.values(hash).map((value) => JSON.parse(value) as Event);
      events.sort((a, b) => a.id - b.id);

      logDebug('Events cache hit (all)', { count: events.length });
      return events;
    } catch (error) {
      logError('Events cache get all error', error);
      return null;
    }
  },

  // Get single event by ID from hash
  async getById(id: number): Promise<Event | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Event:${getCurrentSeason()}`;
      const cached = await redis.hget(key, id.toString());

      if (!cached) {
        logDebug('Event cache miss', { id });
        return null;
      }

      const event = JSON.parse(cached) as Event;
      logDebug('Event cache hit', { id });
      return event;
    } catch (error) {
      logError('Event cache get by id error', error, { id });
      return null;
    }
  },

  // Get current event (filter from all events in memory - fast for 38 events)
  async getCurrent(): Promise<Event | null> {
    try {
      const allEvents = await eventsCache.getAll();
      if (!allEvents) {
        logDebug('Current event cache miss');
        return null;
      }

      const currentEvent = allEvents.find((e) => e.isCurrent);
      if (currentEvent) {
        logDebug('Current event cache hit', { id: currentEvent.id });
      }
      return currentEvent || null;
    } catch (error) {
      logError('Current event cache get error', error);
      return null;
    }
  },

  // Get next event (filter from all events in memory - fast for 38 events)
  async getNext(): Promise<Event | null> {
    try {
      const allEvents = await eventsCache.getAll();
      if (!allEvents) {
        logDebug('Next event cache miss');
        return null;
      }

      const nextEvent = allEvents.find((e) => e.isNext);
      if (nextEvent) {
        logDebug('Next event cache hit', { id: nextEvent.id });
      }
      return nextEvent || null;
    } catch (error) {
      logError('Next event cache get error', error);
      return null;
    }
  },

  // Legacy method for backward compatibility (deadline times only)
  async get(): Promise<EventCacheData[] | null> {
    try {
      const allEvents = await eventsCache.getAll();
      if (!allEvents) return null;

      // Convert to legacy format (just id and deadlineTime)
      const events = allEvents.map((event) => ({
        id: event.id,
        deadlineTime:
          event.deadlineTime instanceof Date
            ? event.deadlineTime.toISOString()
            : event.deadlineTime || '',
      }));

      return events;
    } catch (error) {
      logError('Events cache get error', error);
      return null;
    }
  },

  // Store all events in a single hash (no duplication!)
  async set(events: Event[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Event:${season}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (events.length > 0) {
        // Store each event as a hash field (event ID -> full event JSON)
        const eventFields: Record<string, string> = {};
        for (const event of events) {
          eventFields[event.id.toString()] = JSON.stringify(event);
        }
        pipeline.hset(key, eventFields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Events cache updated (hash)', { count: events.length, season });
    } catch (error) {
      logError('Events cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Event:${getCurrentSeason()}`;
      await redis.del(key);
      logDebug('Events cache cleared', { key });
    } catch (error) {
      logError('Events cache clear error', error);
      throw error;
    }
  },
};

export const teamsCache = {
  // Get all teams (full objects from hash)
  async getAll(): Promise<Team[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Team:${getCurrentSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Teams cache miss (all)');
        return null;
      }

      // Parse all team objects from hash
      const teams = Object.values(hash).map((value) => JSON.parse(value) as Team);
      teams.sort((a, b) => a.id - b.id);

      logDebug('Teams cache hit (all)', { count: teams.length });
      return teams;
    } catch (error) {
      logError('Teams cache get all error', error);
      return null;
    }
  },

  // Get single team by ID from hash
  async getById(id: number): Promise<Team | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Team:${getCurrentSeason()}`;
      const cached = await redis.hget(key, id.toString());

      if (!cached) {
        logDebug('Team cache miss', { id });
        return null;
      }

      const team = JSON.parse(cached) as Team;
      logDebug('Team cache hit', { id });
      return team;
    } catch (error) {
      logError('Team cache get by id error', error, { id });
      return null;
    }
  },

  // Get teams map for transformers (hot path: frequently used in player-stats/values sync)
  async getTeamsMap(): Promise<Map<number, { name: string; shortName: string }> | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Team:${getCurrentSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Teams map cache miss');
        return null;
      }

      // Build map efficiently - only parse needed fields
      const teamsMap = new Map<number, { name: string; shortName: string }>();
      for (const [_teamId, teamJson] of Object.entries(hash)) {
        const team = JSON.parse(teamJson) as Team;
        teamsMap.set(team.id, {
          name: team.name,
          shortName: team.shortName,
        });
      }

      logDebug('Teams map cache hit', { count: teamsMap.size });
      return teamsMap;
    } catch (error) {
      logError('Teams map cache get error', error);
      return null;
    }
  },

  // Legacy method for backward compatibility
  async get(): Promise<TeamCacheData[] | null> {
    try {
      const allTeams = await teamsCache.getAll();
      if (!allTeams) return null;

      // Convert to legacy format (just id, name, shortName)
      const teams = allTeams.map((team) => ({
        id: team.id,
        name: team.name,
        shortName: team.shortName,
      }));

      return teams;
    } catch (error) {
      logError('Teams cache get error', error);
      return null;
    }
  },

  // Store all teams in a single hash (efficient batch operation)
  async set(teams: Team[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Team:${season}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (teams.length > 0) {
        // Store each team as a hash field (team ID -> full team JSON)
        const teamFields: Record<string, string> = {};
        for (const team of teams) {
          teamFields[team.id.toString()] = JSON.stringify(team);
        }
        pipeline.hset(key, teamFields);
        pipeline.expire(key, CACHE_TTL.TEAMS);
      }

      await pipeline.exec();
      logDebug('Teams cache updated (hash)', { count: teams.length, season });
    } catch (error) {
      logError('Teams cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Team:${getCurrentSeason()}`;
      await redis.del(key);
      logDebug('Teams cache cleared', { key });
    } catch (error) {
      logError('Teams cache clear error', error);
      throw error;
    }
  },
};

export const phasesCache = {
  // Get all phases (full objects from hash)
  async getAll(): Promise<Phase[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Phase:${getCurrentSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Phases cache miss (all)');
        return null;
      }

      // Parse all phase objects from hash
      const phases = Object.values(hash).map((value) => JSON.parse(value) as Phase);
      phases.sort((a, b) => a.id - b.id);

      logDebug('Phases cache hit (all)', { count: phases.length });
      return phases;
    } catch (error) {
      logError('Phases cache get all error', error);
      return null;
    }
  },

  // Get single phase by ID from hash
  async getById(id: number): Promise<Phase | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `Phase:${getCurrentSeason()}`;
      const cached = await redis.hget(key, id.toString());

      if (!cached) {
        logDebug('Phase cache miss', { id });
        return null;
      }

      const phase = JSON.parse(cached) as Phase;
      logDebug('Phase cache hit', { id });
      return phase;
    } catch (error) {
      logError('Phase cache get by id error', error, { id });
      return null;
    }
  },

  // Legacy method for backward compatibility
  async get(): Promise<Phase[] | null> {
    return phasesCache.getAll();
  },

  // Store all phases in a single hash (efficient batch operation)
  async set(phases: Phase[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Phase:${season}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (phases.length > 0) {
        // Store each phase as a hash field (phase ID -> full phase JSON)
        const phaseFields: Record<string, string> = {};
        for (const phase of phases) {
          phaseFields[phase.id.toString()] = JSON.stringify(phase);
        }
        pipeline.hset(key, phaseFields);
        pipeline.expire(key, CACHE_TTL.PHASES);
      }

      await pipeline.exec();
      logDebug('Phases cache updated (hash)', { count: phases.length, season });
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

export const fixturesCache = {
  revive(fixture: Fixture): Fixture {
    const kickoffTime = fixture.kickoffTime
      ? new Date(fixture.kickoffTime as unknown as string)
      : null;
    const createdAt = fixture.createdAt ? new Date(fixture.createdAt as unknown as string) : null;
    const updatedAt = fixture.updatedAt ? new Date(fixture.updatedAt as unknown as string) : null;

    return {
      ...fixture,
      kickoffTime: kickoffTime && !Number.isNaN(kickoffTime.getTime()) ? kickoffTime : null,
      createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      updatedAt: updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null,
    };
  },

  // Get all fixtures (aggregate from all event keys including unscheduled)
  async getAll(): Promise<Fixture[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const pattern = `Fixtures:${season}:*`;
      const keys = await redis.keys(pattern);

      if (keys.length === 0) {
        logDebug('Fixtures cache miss (all)');
        return null;
      }

      const allFixtures: Fixture[] = [];
      for (const key of keys) {
        const hash = await redis.hgetall(key);
        if (hash && Object.keys(hash).length > 0) {
          const fixtures = Object.values(hash)
            .map((value) => JSON.parse(value) as Fixture)
            .map((fixture) => fixturesCache.revive(fixture));
          allFixtures.push(...fixtures);
        }
      }

      if (allFixtures.length === 0) {
        logDebug('Fixtures cache miss (all)');
        return null;
      }

      allFixtures.sort((a, b) => a.id - b.id);
      logDebug('Fixtures cache hit (all)', {
        count: allFixtures.length,
        keys: keys.length,
      });
      return allFixtures;
    } catch (error) {
      logError('Fixtures cache get all error', error);
      return null;
    }
  },

  // Get single fixture by ID (search across event keys)
  async getById(id: number): Promise<Fixture | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const pattern = `Fixtures:${season}:*`;
      const keys = await redis.keys(pattern);

      for (const key of keys) {
        const cached = await redis.hget(key, id.toString());
        if (cached) {
          const fixture = fixturesCache.revive(JSON.parse(cached) as Fixture);
          logDebug('Fixture cache hit', { id });
          return fixture;
        }
      }

      logDebug('Fixture cache miss', { id });
      return null;
    } catch (error) {
      logError('Fixture cache get by id error', error, { id });
      return null;
    }
  },

  // Get fixtures by event (direct hash lookup)
  async getByEvent(eventId: number): Promise<Fixture[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Fixtures by event cache miss', { eventId });
        return null;
      }

      const fixtures = Object.values(hash)
        .map((value) => JSON.parse(value) as Fixture)
        .map((fixture) => fixturesCache.revive(fixture));
      fixtures.sort((a, b) => a.id - b.id);

      logDebug('Fixtures by event cache hit', { eventId, count: fixtures.length });
      return fixtures;
    } catch (error) {
      logError('Fixtures by event cache get error', error, { eventId });
      return null;
    }
  },

  // Get fixtures by team (search across all event keys)
  async getByTeam(teamId: number): Promise<Fixture[] | null> {
    try {
      const allFixtures = await fixturesCache.getAll();
      if (!allFixtures) {
        logDebug('Fixtures by team cache miss', { teamId });
        return null;
      }

      const teamFixtures = allFixtures.filter((f) => f.teamA === teamId || f.teamH === teamId);
      if (teamFixtures.length > 0) {
        logDebug('Fixtures by team cache hit', { teamId, count: teamFixtures.length });
      }
      return teamFixtures.length > 0 ? teamFixtures : null;
    } catch (error) {
      logError('Fixtures by team cache get error', error, { teamId });
      return null;
    }
  },

  // Store fixtures by event (event-specific hash)
  async setByEvent(eventId: number, fixtures: Fixture[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:${eventId}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash for this event
      pipeline.del(key);

      if (fixtures.length > 0) {
        // Store each fixture as a hash field (fixture ID -> full fixture JSON)
        const fixtureFields: Record<string, string> = {};
        for (const fixture of fixtures) {
          fixtureFields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fixtureFields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Fixtures cache updated by event', { eventId, count: fixtures.length, season });
    } catch (error) {
      logError('Fixtures cache set by event error', error, { eventId });
      throw error;
    }
  },

  // Store all fixtures (group by event)
  async set(fixtures: Fixture[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();

      // Group fixtures by event (including unscheduled)
      const fixturesByEvent = new Map<number | string, Fixture[]>();
      const unscheduledFixtures: Fixture[] = [];

      for (const fixture of fixtures) {
        if (!fixture.event) {
          unscheduledFixtures.push(fixture);
        } else {
          if (!fixturesByEvent.has(fixture.event)) {
            fixturesByEvent.set(fixture.event, []);
          }
          fixturesByEvent.get(fixture.event)!.push(fixture);
        }
      }

      // Use pipeline for batch operation
      const pipeline = redis.pipeline();

      // Clear all existing fixture keys for this season
      const pattern = `Fixtures:${season}:*`;
      const existingKeys = await redis.keys(pattern);
      if (existingKeys.length > 0) {
        for (const key of existingKeys) {
          pipeline.del(key);
        }
      }

      // Set fixtures for each event
      for (const [eventId, eventFixtures] of fixturesByEvent) {
        const key = `Fixtures:${season}:${eventId}`;
        const fixtureFields: Record<string, string> = {};
        for (const fixture of eventFixtures) {
          fixtureFields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fixtureFields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      // Store unscheduled fixtures separately
      if (unscheduledFixtures.length > 0) {
        const key = `Fixtures:${season}:unscheduled`;
        const fixtureFields: Record<string, string> = {};
        for (const fixture of unscheduledFixtures) {
          fixtureFields[fixture.id.toString()] = JSON.stringify(fixture);
        }
        pipeline.hset(key, fixtureFields);
        pipeline.expire(key, CACHE_TTL.EVENTS);
      }

      await pipeline.exec();
      logDebug('Fixtures cache updated (all events)', {
        count: fixtures.length,
        scheduled: fixtures.length - unscheduledFixtures.length,
        unscheduled: unscheduledFixtures.length,
        events: fixturesByEvent.size,
        season,
      });
    } catch (error) {
      logError('Fixtures cache set error', error);
      throw error;
    }
  },

  // Clear all fixtures cache for season
  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const pattern = `Fixtures:${season}:*`;
      const keys = await redis.keys(pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
      }

      logDebug('Fixtures cache cleared', { season, keysCleared: keys.length });
    } catch (error) {
      logError('Fixtures cache clear error', error);
      throw error;
    }
  },

  // Clear fixtures cache for specific event
  async clearByEvent(eventId: number): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Fixtures:${season}:${eventId}`;
      await redis.del(key);
      logDebug('Fixtures cache cleared by event', { eventId, season });
    } catch (error) {
      logError('Fixtures cache clear by event error', error, { eventId });
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

// ================================
// Player Values Cache Class
// ================================

/**
 * Player Values Hash Cache - for player value change tracking by date
 * Uses changeDate (YYYYMMDD) as primary cache key since price changes are daily
 */
export class PlayerValuesHashCache extends CacheOperations {
  private getDateKey(changeDate: string): string {
    return `PlayerValue:${changeDate}`;
  }

  private getPlayerKey(playerId: PlayerId): string {
    return `${playerId}`;
  }

  // Date-based operations (primary cache strategy)
  async getPlayerValuesByDate(changeDate: string): Promise<PlayerValue[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const dateKey = this.getDateKey(changeDate);
      const playerValuesData = await redis.hgetall(dateKey);

      if (!playerValuesData || Object.keys(playerValuesData).length === 0) {
        return null;
      }

      const playerValues: PlayerValue[] = [];
      for (const [playerId, serializedData] of Object.entries(playerValuesData)) {
        try {
          const playerValue = JSON.parse(serializedData) as PlayerValue;
          playerValues.push(playerValue);
        } catch (error) {
          logError('Failed to parse cached player value', error, { changeDate, playerId });
        }
      }

      return playerValues;
    } catch (error) {
      logError('Failed to get cached player values by date', error, { changeDate });
      return null;
    }
  }

  async setPlayerValuesByDate(changeDate: string, playerValues: PlayerValue[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const dateKey = this.getDateKey(changeDate);
      const playerValuesData: Record<string, string> = {};

      for (const playerValue of playerValues) {
        const playerKey = this.getPlayerKey(playerValue.elementId);
        playerValuesData[playerKey] = JSON.stringify(playerValue);
      }

      if (Object.keys(playerValuesData).length === 0) {
        logDebug('No valid player values to cache for date', { changeDate });
        return;
      }

      await redis.hset(dateKey, playerValuesData);
      await redis.expire(dateKey, CACHE_TTL.player_values);

      logDebug('Player values cache set by date', {
        changeDate,
        key: dateKey,
        count: playerValues.length,
      });
    } catch (error) {
      logError('Failed to cache player values by date', error, {
        changeDate,
        count: playerValues.length,
      });
      throw error; // Re-throw so caller knows cache failed
    }
  }

  // Individual player value operations
  async getPlayerValue(eventId: EventId, playerId: PlayerId): Promise<PlayerValue | null> {
    try {
      const redis = await redisSingleton.getClient();
      const eventKey = this.getEventKey(eventId);
      const playerKey = this.getPlayerKey(eventId, playerId);
      const serializedData = await redis.hget(eventKey, playerKey);

      if (!serializedData) {
        return null;
      }

      return JSON.parse(serializedData) as PlayerValue;
    } catch (error) {
      logError('Failed to get cached player value', error, { eventId, playerId });
      return null;
    }
  }

  async setPlayerValue(playerValue: PlayerValue): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const eventKey = this.getEventKey(playerValue.eventId);
      const playerKey = this.getPlayerKey(playerValue.eventId, playerValue.elementId);
      const serializedData = JSON.stringify(playerValue);

      await redis.hset(eventKey, playerKey, serializedData);
      await redis.expire(eventKey, CACHE_TTL.player_values);
    } catch (error) {
      logError('Failed to cache player value', error, {
        eventId: playerValue.eventId,
        playerId: playerValue.elementId,
      });
    }
  }

  // Filtered operations
  async getPlayerValuesByTeam(eventId: EventId, teamId: TeamId): Promise<PlayerValue[] | null> {
    try {
      const allPlayerValues = await this.getPlayerValuesByEvent(eventId);
      if (!allPlayerValues) return null;

      return allPlayerValues.filter((pv) => pv.teamId === teamId);
    } catch (error) {
      logError('Failed to get cached player values by team', error, { eventId, teamId });
      return null;
    }
  }

  async getPlayerValuesByPosition(
    eventId: EventId,
    elementType: ElementTypeId,
  ): Promise<PlayerValue[] | null> {
    try {
      const allPlayerValues = await this.getPlayerValuesByEvent(eventId);
      if (!allPlayerValues) return null;

      return allPlayerValues.filter((pv) => pv.elementType === elementType);
    } catch (error) {
      logError('Failed to get cached player values by position', error, { eventId, elementType });
      return null;
    }
  }

  async getPlayerValuesByChangeType(
    eventId: EventId,
    changeType: ValueChangeType,
  ): Promise<PlayerValue[] | null> {
    try {
      const allPlayerValues = await this.getPlayerValuesByEvent(eventId);
      if (!allPlayerValues) return null;

      return allPlayerValues.filter((pv) => pv.changeType === changeType);
    } catch (error) {
      logError('Failed to get cached player values by change type', error, { eventId, changeType });
      return null;
    }
  }

  // Utility operations
  async clearByEvent(eventId: EventId): Promise<void> {
    try {
      const eventKey = this.getEventKey(eventId);
      await this.del(eventKey);
    } catch (error) {
      logError('Failed to clear cached player values by event', error, { eventId });
    }
  }

  async existsByEvent(eventId: EventId): Promise<boolean> {
    try {
      const eventKey = this.getEventKey(eventId);
      return await this.exists(eventKey);
    } catch (error) {
      logError('Failed to check cached player values existence by event', error, { eventId });
      return false;
    }
  }

  async clearAll(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const pattern = `${DEFAULT_CACHE_CONFIG.prefix}player_values:*`;
      const keys = await redis.keys(pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      logError('Failed to clear all cached player values', error);
    }
  }

  async getLatestEventId(): Promise<EventId | null> {
    try {
      const redis = await redisSingleton.getClient();
      const pattern = `${DEFAULT_CACHE_CONFIG.prefix}player_values:event:*`;
      const keys = await redis.keys(pattern);

      if (keys.length === 0) return null;

      // Extract event IDs and find the latest
      const eventIds = keys
        .map((key: string) => {
          const match = key.match(/player_values:event:(\d+)$/);
          return match ? parseInt(match[1]) : null;
        })
        .filter((id): id is number => id !== null)
        .sort((a: number, b: number) => b - a);

      return eventIds[0] || null;
    } catch (error) {
      logError('Failed to get latest event ID from cached player values', error);
      return null;
    }
  }
}

/**
 * Player values cache instance - date-based caching for daily price changes
 */
export const playerValuesCache = {
  private: new PlayerValuesHashCache(),

  // Date-based operations (primary strategy)
  async getByDate(changeDate: string): Promise<PlayerValue[] | null> {
    return this.private.getPlayerValuesByDate(changeDate);
  },

  async setByDate(changeDate: string, playerValues: PlayerValue[]): Promise<void> {
    return this.private.setPlayerValuesByDate(changeDate, playerValues);
  },

  async clearByDate(changeDate: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = this.private['getDateKey'](changeDate);
      await redis.del(key);
    } catch (error) {
      logError('Failed to clear cached player values by date', error, { changeDate });
    }
  },

  // Utility operations
  async clearAll(): Promise<void> {
    return this.private.clearAll();
  },

  // Deprecated: Legacy daily operations (kept for compatibility)
  async setDailyChanges(changeDate: string, playerValues: PlayerValue[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue::${changeDate}`;
      const value = JSON.stringify(playerValues);

      // Cache for 1 day (24 hours)
      await redis.setex(key, 86400, value);

      logInfo('Daily player values cached', {
        changeDate,
        count: playerValues.length,
        key,
      });
    } catch (error) {
      logError('Failed to cache daily player values', error, { changeDate });
      throw error;
    }
  },

  async getDailyChanges(changeDate: string): Promise<PlayerValue[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue::${changeDate}`;
      const cached = await redis.get(key);

      if (!cached) {
        return null;
      }

      const playerValues = JSON.parse(cached) as PlayerValue[];
      logInfo('Daily player values retrieved from cache', {
        changeDate,
        count: playerValues.length,
      });

      return playerValues;
    } catch (error) {
      logError('Failed to get daily player values from cache', error, { changeDate });
      return null;
    }
  },

  async clearDailyChanges(changeDate: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `PlayerValue::${changeDate}`;
      await redis.del(key);

      logInfo('Daily player values cache cleared', { changeDate });
    } catch (error) {
      logError('Failed to clear daily player values cache', error, { changeDate });
      throw error;
    }
  },
};

/**
 * Event Live Cache Operations
 * Pattern: EventLive:season:eventId -> hash of elementId -> EventLive data
 */
export const eventLivesCache = {
  /**
   * Get all event live data for a specific event
   */
  async getByEventId(eventId: EventId): Promise<EventLive[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event lives cache miss', { eventId });
        return null;
      }

      const eventLives = Object.values(hash).map((value) => JSON.parse(value) as EventLive);
      logDebug('Event lives cache hit', { eventId, count: eventLives.length });
      return eventLives;
    } catch (error) {
      logError('Event lives cache get by event error', error, { eventId });
      return null;
    }
  },

  /**
   * Get single event live record for a specific element in an event
   */
  async getByEventAndElement(eventId: EventId, elementId: PlayerId): Promise<EventLive | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;
      const cached = await redis.hget(key, elementId.toString());

      if (!cached) {
        logDebug('Event live cache miss', { eventId, elementId });
        return null;
      }

      const eventLive = JSON.parse(cached) as EventLive;
      logDebug('Event live cache hit', { eventId, elementId });
      return eventLive;
    } catch (error) {
      logError('Event live cache get by event and element error', error, { eventId, elementId });
      return null;
    }
  },

  /**
   * Set event live data for an event (batch)
   */
  async set(eventId: EventId, eventLives: EventLive[]): Promise<void> {
    try {
      if (eventLives.length === 0) {
        logInfo('No event live data to cache', { eventId });
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;

      // Build hash: elementId -> EventLive data
      const hashData: Record<string, string> = {};
      for (const eventLive of eventLives) {
        hashData[eventLive.elementId.toString()] = JSON.stringify(eventLive);
      }

      // Clear existing hash and set new data
      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_LIVE);

      logInfo('Event lives cached', { eventId, count: eventLives.length });
    } catch (error) {
      logError('Event lives cache set error', error, { eventId, count: eventLives.length });
      throw error;
    }
  },

  /**
   * Clear cache for a specific event
   */
  async clearByEventId(eventId: EventId): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLive:${getCurrentSeason()}:${eventId}`;
      await redis.del(key);

      logInfo('Event lives cache cleared', { eventId });
    } catch (error) {
      logError('Failed to clear event lives cache', error, { eventId });
      throw error;
    }
  },

  /**
   * Clear all event lives cache for the current season
   */
  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const pattern = `${DEFAULT_CACHE_CONFIG.prefix}EventLive:${getCurrentSeason()}:*`;
      const keys = await redis.keys(pattern);

      if (keys.length > 0) {
        await redis.del(...keys);
        logInfo('All event lives cache cleared', { deletedKeys: keys.length });
      } else {
        logInfo('No event lives cache to clear');
      }
    } catch (error) {
      logError('Failed to clear all event lives cache', error);
      throw error;
    }
  },
};
