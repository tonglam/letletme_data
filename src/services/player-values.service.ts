import { playerValuesCache, teamsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type { PlayerValue } from '../domain/player-values';
import {
  filterPlayerValuesByChangeType,
  filterPlayerValuesByPosition,
  filterPlayerValuesByTeam,
  getTopValueFallers,
  getTopValueRisers,
  getValueChangeStats,
  sortPlayerValuesByChangeAmount,
  sortPlayerValuesByValue,
} from '../domain/player-values';
import { playerValuesRepository } from '../repositories/player-values';
import { teamRepository } from '../repositories/teams';
import { createPreviousValuesMap, createTeamsMap } from '../transformers/player-values';
import type { EventId, PlayerId, PlayerTypeID, TeamId, ValueChangeType } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';

// PlayerValueQueryResult now matches PlayerValue exactly, so no transformation needed

/**
 * Player Values Service - Business Logic Layer
 *
 * Handles all player values-related operations:
 * - Data synchronization from FPL API
 * - Database operations with business logic
 * - Data retrieval with filtering and sorting
 * - Analytics and aggregations
 */

// Get all player values
export async function getPlayerValues(): Promise<PlayerValue[]> {
  try {
    logInfo('Getting all player values');

    const dbPlayerValues = await playerValuesRepository.findAll();

    logInfo('Player values retrieved from database', { count: dbPlayerValues.length });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values', error);
    throw error;
  }
}

// Get player values by event ID (no cache - event-based queries go to DB)
export async function getPlayerValuesByEvent(eventId: EventId): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by event', { eventId });

    // Event-based queries don't use cache (player values are cached by date)
    const dbPlayerValues = await playerValuesRepository.findByEventId(eventId);

    logInfo('Player values retrieved from database', { eventId, count: dbPlayerValues.length });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values by event', error, { eventId });
    throw error;
  }
}

// Get player values by change date (cache-first strategy)
export async function getPlayerValuesByDate(changeDate: string): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by date', { changeDate });

    // 1. Try cache first (fast path)
    const cached = await playerValuesCache.getByDate(changeDate);
    if (cached) {
      logInfo('Player values retrieved from cache', { changeDate, count: cached.length });
      return cached;
    }

    // 2. Cache miss - this shouldn't happen often since cache is populated during sync
    // Return empty array (cache should be the source of truth for date-based queries)
    logInfo('Cache miss for date-based query', { changeDate });
    return [];
  } catch (error) {
    logError('Failed to get player values by date', error, { changeDate });
    throw error;
  }
}

// Get player values by player ID
export async function getPlayerValuesByPlayer(playerId: PlayerId): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by player', { playerId });

    const dbPlayerValues = await playerValuesRepository.findByPlayerId(playerId);

    logInfo('Player values retrieved by player', { playerId, count: dbPlayerValues.length });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values by player', error, { playerId });
    throw error;
  }
}

// Get player values by team ID
export async function getPlayerValuesByTeam(
  teamId: TeamId,
  eventId?: EventId,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by team', { teamId, eventId });

    // No cache for filtered queries (date-based cache only)
    const dbPlayerValues = await playerValuesRepository.findByTeamId(teamId, eventId);

    logInfo('Player values retrieved by team', { teamId, eventId, count: dbPlayerValues.length });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values by team', error, { teamId, eventId });
    throw error;
  }
}

// Get player values by position
export async function getPlayerValuesByPosition(
  elementType: PlayerTypeID,
  eventId?: EventId,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by position', { elementType, eventId });

    // No cache for filtered queries (date-based cache only)
    const dbPlayerValues = await playerValuesRepository.findByPosition(elementType, eventId);

    logInfo('Player values retrieved by position', {
      elementType,
      eventId,
      count: dbPlayerValues.length,
    });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values by position', error, { elementType, eventId });
    throw error;
  }
}

// Get player values by change type
export async function getPlayerValuesByChangeType(
  changeType: ValueChangeType,
  eventId?: EventId,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting player values by change type', { changeType, eventId });

    // No cache for filtered queries (date-based cache only)
    const dbPlayerValues = await playerValuesRepository.findByChangeType(changeType, eventId);

    logInfo('Player values retrieved by change type', {
      changeType,
      eventId,
      count: dbPlayerValues.length,
    });
    return dbPlayerValues;
  } catch (error) {
    logError('Failed to get player values by change type', error, { changeType, eventId });
    throw error;
  }
}

// Get specific player value by event and player
export async function getPlayerValue(
  eventId: EventId,
  playerId: PlayerId,
): Promise<PlayerValue | null> {
  try {
    logInfo('Getting specific player value', { eventId, playerId });

    // No cache for individual queries (date-based cache only)
    const dbPlayerValue = await playerValuesRepository.findByEventAndPlayer(eventId, playerId);

    logInfo('Player value retrieved from database', { eventId, playerId, found: !!dbPlayerValue });
    return dbPlayerValue;
  } catch (error) {
    logError('Failed to get specific player value', error, { eventId, playerId });
    throw error;
  }
}

// Get top value risers for an event
export async function getTopValueRisersForEvent(
  eventId: EventId,
  limit: number = 10,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting top value risers for event', { eventId, limit });

    const playerValues = await getPlayerValuesByEvent(eventId);
    const topRisers = [...getTopValueRisers(playerValues, limit)];

    logInfo('Top value risers retrieved', { eventId, limit, count: topRisers.length });
    return topRisers;
  } catch (error) {
    logError('Failed to get top value risers for event', error, { eventId, limit });
    throw error;
  }
}

// Get top value fallers for an event
export async function getTopValueFallersForEvent(
  eventId: EventId,
  limit: number = 10,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting top value fallers for event', { eventId, limit });

    const playerValues = await getPlayerValuesByEvent(eventId);
    const topFallers = [...getTopValueFallers(playerValues, limit)];

    logInfo('Top value fallers retrieved', { eventId, limit, count: topFallers.length });
    return topFallers;
  } catch (error) {
    logError('Failed to get top value fallers for event', error, { eventId, limit });
    throw error;
  }
}

// Get value change analytics for an event
export async function getPlayerValuesAnalytics(eventId?: EventId): Promise<{
  totalRisers: number;
  totalFallers: number;
  totalStable: number;
  averageValue: number;
  totalValueChange: number;
  topRisers: PlayerValue[];
  topFallers: PlayerValue[];
}> {
  try {
    logInfo('Getting player values analytics', { eventId });

    const playerValues = eventId ? await getPlayerValuesByEvent(eventId) : await getPlayerValues();

    const stats = getValueChangeStats(playerValues);
    const topRisers = [...getTopValueRisers(playerValues, 5)];
    const topFallers = [...getTopValueFallers(playerValues, 5)];

    const analytics = {
      ...stats,
      topRisers,
      topFallers,
    };

    logInfo('Player values analytics retrieved', { eventId, analytics });
    return analytics;
  } catch (error) {
    logError('Failed to get player values analytics', error, { eventId });
    throw error;
  }
}

// Sync current player values from FPL API (Daily change detection approach)
export async function syncCurrentPlayerValues(): Promise<{ count: number }> {
  try {
    logInfo('Starting daily player values sync');

    // 1. Fetch current bootstrap data from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    // 2. Find current event for reference
    const currentEvent = bootstrapData.events.find((event) => event.is_current);
    if (!currentEvent) {
      throw new Error('No current event found in FPL bootstrap data');
    }

    // 3. Generate today's date in YYYYMMDD format (matching Java logic)
    const today = new Date();
    const changeDate = today.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD format

    // 4. Get latest stored values for each player (last known prices)
    const lastStoredValues = await playerValuesRepository.findLatestForAllPlayers();
    const lastValueMap = new Map<number, number>();
    lastStoredValues.forEach((pv) => {
      lastValueMap.set(pv.elementId, pv.value);
    });

    // 5. Get existing records for today to avoid duplicates
    const todaysRecords = await playerValuesRepository.findByChangeDate(changeDate);
    const todaysPlayerIds = new Set(todaysRecords.map((pv) => pv.elementId));

    // 6. Get teams map (try cache first, fallback to DB)
    let teamsMap = await teamsCache.getTeamsMap();
    if (!teamsMap) {
      logInfo('Teams map cache miss, fetching from database');
      const teams = await teamRepository.findAll();
      teamsMap = createTeamsMap(
        teams.map((team) => ({
          id: team.id,
          name: team.name,
          shortName: team.shortName,
        })),
      );
    }

    // 7. Filter and transform only players with price changes
    const playersWithChanges = bootstrapData.elements.filter((player) => {
      // Skip if already processed today
      if (todaysPlayerIds.has(player.id)) {
        return false;
      }

      const lastValue = lastValueMap.get(player.id) || 0;
      const currentValue = player.now_cost;

      // Only include players whose prices have changed
      return currentValue !== lastValue;
    });

    if (playersWithChanges.length === 0) {
      logInfo('No player price changes detected today');
      return { count: 0 };
    }

    // 8. Transform changed players to PlayerValue objects
    const { transformPlayerValuesWithChanges } = await import('../transformers/player-values');
    const playerValues = transformPlayerValuesWithChanges(
      playersWithChanges,
      currentEvent.id,
      teamsMap,
      lastValueMap,
      changeDate,
    );

    // 9. Insert new records (not upsert since we filtered duplicates)
    const result = await playerValuesRepository.insertBatch(playerValues);

    // 10. Update cache with all changes for the date
    if (result.count > 0) {
      await playerValuesCache.setByDate(changeDate, playerValues);
      logInfo('Player values cache updated for date', { changeDate, count: result.count });
    }

    logInfo('Daily player values sync completed', {
      eventId: currentEvent.id,
      changeDate,
      totalChecked: bootstrapData.elements.length,
      changesDetected: playersWithChanges.length,
      recordsInserted: result.count,
    });

    return result;
  } catch (error) {
    logError('Failed to sync current player values', error);
    throw error;
  }
}

// Sync player values for specific event
export async function syncPlayerValuesForEvent(eventId: EventId): Promise<{ count: number }> {
  try {
    logInfo('Starting player values sync for event', { eventId });

    // 1. Fetch data from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    // 2. Get teams map (try cache first, fallback to DB)
    let teamsMap = await teamsCache.getTeamsMap();
    if (!teamsMap) {
      logInfo('Teams map cache miss, fetching from database');
      const teams = await teamRepository.findAll();
      teamsMap = createTeamsMap(
        teams.map((team) => ({
          id: team.id,
          name: team.name,
          shortName: team.shortName,
        })),
      );
    }

    // 3. Get previous values from database for comparison
    const previousPlayerValues = await playerValuesRepository.findByEventId(eventId - 1);
    const previousValuesMap = createPreviousValuesMap(
      previousPlayerValues.map((pv) => ({ elementId: pv.elementId, value: pv.value })),
    );

    // 4. Transform data to domain objects
    const { transformPlayerValues } = await import('../transformers/player-values');
    const playerValues = transformPlayerValues(
      bootstrapData.elements,
      eventId,
      teamsMap,
      previousValuesMap,
      new Date().toISOString(),
    );

    // 5. Upsert to database
    const result = await playerValuesRepository.upsertBatch(playerValues);

    // 6. Update cache (by changeDate, not eventId)
    if (playerValues.length > 0) {
      const changeDate = playerValues[0].changeDate;
      await playerValuesCache.setByDate(changeDate, playerValues);
      logInfo('Player values cache updated for date', { changeDate, count: result.count });
    }

    logInfo('Player values sync for event completed', { eventId, count: result.count });

    return result;
  } catch (error) {
    logError('Failed to sync player values for event', error, { eventId });
    throw error;
  }
}

// Delete player values by event ID
export async function deletePlayerValuesByEvent(eventId: EventId): Promise<void> {
  try {
    logInfo('Deleting player values by event', { eventId });

    // 1. Delete from database
    await playerValuesRepository.deleteByEventId(eventId);

    // 2. Clear from cache
    // Cache is date-based, no event-specific clearing needed

    logInfo('Player values deleted by event', { eventId });
  } catch (error) {
    logError('Failed to delete player values by event', error, { eventId });
    throw error;
  }
}

// Get latest available event ID
export async function getLatestPlayerValuesEventId(): Promise<EventId | null> {
  try {
    logInfo('Getting latest player values event ID');

    // Get latest event directly from database (no cache for this metadata)
    const dbEventId = await playerValuesRepository.getLatestEventId();

    logInfo('Latest event ID retrieved from database', { eventId: dbEventId });
    return dbEventId;
  } catch (error) {
    logError('Failed to get latest player values event ID', error);
    throw error;
  }
}

// Get player values count
export async function getPlayerValuesCount(): Promise<number> {
  try {
    logInfo('Getting player values count');

    const count = await playerValuesRepository.getPlayerValuesCount();

    logInfo('Player values count retrieved', { count });
    return count;
  } catch (error) {
    logError('Failed to get player values count', error);
    throw error;
  }
}

// Advanced filtering and sorting
export async function getFilteredAndSortedPlayerValues(
  filters: {
    eventId?: EventId;
    teamId?: TeamId;
    position?: PlayerTypeID;
    changeType?: ValueChangeType;
  },
  sortBy?: 'value' | 'change' | 'name',
  limit?: number,
): Promise<PlayerValue[]> {
  try {
    logInfo('Getting filtered and sorted player values', { filters, sortBy, limit });

    // Get base data
    let playerValues: PlayerValue[];

    if (filters.eventId) {
      playerValues = await getPlayerValuesByEvent(filters.eventId);
    } else {
      playerValues = await getPlayerValues();
    }

    // Apply filters
    if (filters.teamId) {
      playerValues = [...filterPlayerValuesByTeam(playerValues, filters.teamId)];
    }

    if (filters.position) {
      playerValues = [...filterPlayerValuesByPosition(playerValues, filters.position)];
    }

    if (filters.changeType) {
      playerValues = [...filterPlayerValuesByChangeType(playerValues, filters.changeType)];
    }

    // Apply sorting
    switch (sortBy) {
      case 'value':
        playerValues = [...sortPlayerValuesByValue(playerValues)];
        break;
      case 'change':
        playerValues = [...sortPlayerValuesByChangeAmount(playerValues)];
        break;
      case 'name':
        playerValues = [...playerValues].sort((a, b) => a.webName.localeCompare(b.webName));
        break;
    }

    // Apply limit
    if (limit && limit > 0) {
      playerValues = playerValues.slice(0, limit);
    }

    logInfo('Filtered and sorted player values retrieved', {
      filters,
      sortBy,
      limit,
      count: playerValues.length,
    });

    return playerValues;
  } catch (error) {
    logError('Failed to get filtered and sorted player values', error, { filters, sortBy, limit });
    throw error;
  }
}
