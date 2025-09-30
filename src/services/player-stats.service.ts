import { playerStatsCache, teamsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type { PlayerStat } from '../domain/player-stats';
import { playerStatsRepository } from '../repositories/player-stats';
import { teamRepository } from '../repositories/teams';
import { createTeamsMap, transformCurrentGameweekPlayerStats } from '../transformers/player-stats';
import type { ElementTypeId, EventId, PlayerId, TeamId } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';

/**
 * Player Stats Service - Business Logic Layer
 *
 * Handles all player stats-related operations:
 * - Data synchronization from FPL API
 * - Database operations with business logic
 * - Data retrieval with filtering and sorting
 * - Analytics and aggregations
 */

// Get all player stats
export async function getPlayerStats(): Promise<PlayerStat[]> {
  try {
    logInfo('Getting all player stats');

    const dbPlayerStats = await playerStatsRepository.findAll();

    logInfo('Player stats retrieved from database', { count: dbPlayerStats.length });
    return dbPlayerStats as PlayerStat[];
  } catch (error) {
    logError('Failed to get player stats', error);
    throw error;
  }
}

// Get player stats by event ID (cache-first strategy: Redis → DB → update Redis)
export async function getPlayerStatsByEvent(eventId: EventId): Promise<PlayerStat[]> {
  try {
    logInfo('Getting player stats by event', { eventId });

    // 1. Try cache first (fast path)
    const cached = await playerStatsCache.getByEvent(eventId);
    if (cached) {
      logInfo('Player stats retrieved from cache', { eventId, count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { eventId });
    const dbPlayerStats = await playerStatsRepository.findByEventId(eventId);
    const playerStats = dbPlayerStats as PlayerStat[];

    // 3. Update cache for next time (async, don't block response)
    if (playerStats.length > 0) {
      playerStatsCache.setByEvent(eventId, playerStats).catch((error) => {
        logError('Failed to update player stats cache', error);
      });
    }

    logInfo('Player stats retrieved from database', { eventId, count: playerStats.length });
    return playerStats;
  } catch (error) {
    logError('Failed to get player stats by event', error, { eventId });
    throw error;
  }
}

// Get player stats by player ID
export async function getPlayerStatsByPlayer(playerId: PlayerId): Promise<PlayerStat[]> {
  try {
    logInfo('Getting player stats by player', { playerId });

    const dbPlayerStats = await playerStatsRepository.findByPlayerId(playerId);

    logInfo('Player stats retrieved by player', { playerId, count: dbPlayerStats.length });
    return dbPlayerStats as PlayerStat[];
  } catch (error) {
    logError('Failed to get player stats by player', error, { playerId });
    throw error;
  }
}

// Get player stats by team ID (cache-first for latest event)
export async function getPlayerStatsByTeam(
  teamId: TeamId,
  eventId?: EventId,
): Promise<PlayerStat[]> {
  try {
    logInfo('Getting player stats by team', { teamId, eventId });

    // If eventId provided, try cache first (for latest event)
    if (eventId) {
      const cached = await playerStatsCache.getByTeam(eventId, teamId);
      if (cached) {
        logInfo('Player stats retrieved from cache (filtered by team)', {
          teamId,
          eventId,
          count: cached.length,
        });
        return cached;
      }
    }

    // Cache miss or no eventId - fallback to database
    logInfo('Cache miss or historical query - fetching from database', { teamId, eventId });
    const dbPlayerStats = await playerStatsRepository.findByTeamId(teamId, eventId);

    // Update cache if this is the latest event data
    if (eventId && dbPlayerStats.length > 0) {
      const allStats = await playerStatsCache.getByEvent(eventId);
      if (!allStats) {
        // Cache the full event data
        const allEventStats = await playerStatsRepository.findByEventId(eventId);
        playerStatsCache.setByEvent(eventId, allEventStats as PlayerStat[]).catch((error) => {
          logError('Failed to update player stats cache', error);
        });
      }
    }

    logInfo('Player stats retrieved by team from database', {
      teamId,
      eventId,
      count: dbPlayerStats.length,
    });
    return dbPlayerStats as PlayerStat[];
  } catch (error) {
    logError('Failed to get player stats by team', error, { teamId, eventId });
    throw error;
  }
}

// Get player stats by position (cache-first for latest event)
export async function getPlayerStatsByPosition(
  elementType: ElementTypeId,
  eventId?: EventId,
): Promise<PlayerStat[]> {
  try {
    logInfo('Getting player stats by position', { elementType, eventId });

    // If eventId provided, try cache first (for latest event)
    if (eventId) {
      const cached = await playerStatsCache.getByPosition(eventId, elementType);
      if (cached) {
        logInfo('Player stats retrieved from cache (filtered by position)', {
          elementType,
          eventId,
          count: cached.length,
        });
        return cached;
      }
    }

    // Cache miss or no eventId - fallback to database
    logInfo('Cache miss or historical query - fetching from database', { elementType, eventId });
    const dbPlayerStats = await playerStatsRepository.findByPosition(elementType, eventId);

    // Update cache if this is the latest event data
    if (eventId && dbPlayerStats.length > 0) {
      const allStats = await playerStatsCache.getByEvent(eventId);
      if (!allStats) {
        // Cache the full event data
        const allEventStats = await playerStatsRepository.findByEventId(eventId);
        playerStatsCache.setByEvent(eventId, allEventStats as PlayerStat[]).catch((error) => {
          logError('Failed to update player stats cache', error);
        });
      }
    }

    logInfo('Player stats retrieved by position from database', {
      elementType,
      eventId,
      count: dbPlayerStats.length,
    });
    return dbPlayerStats as PlayerStat[];
  } catch (error) {
    logError('Failed to get player stats by position', error, { elementType, eventId });
    throw error;
  }
}

// Get specific player stat for event and player
export async function getPlayerStat(
  eventId: EventId,
  playerId: PlayerId,
): Promise<PlayerStat | null> {
  try {
    logInfo('Getting player stat by event and player', { eventId, playerId });

    // 1. Try cache first (fast path)
    const cached = await playerStatsCache.getPlayerStat(eventId, playerId);
    if (cached) {
      logInfo('Player stat retrieved from cache', { eventId, playerId });
      return cached;
    }

    // 2. Fallback to database (slower path)
    const dbPlayerStat = await playerStatsRepository.findByEventAndPlayer(eventId, playerId);

    if (dbPlayerStat) {
      const playerStat = dbPlayerStat as PlayerStat;
      // 3. Update cache for next time
      await playerStatsCache.setPlayerStat(playerStat);

      logInfo('Player stat found and cached', { eventId, playerId });
      return playerStat;
    } else {
      logInfo('Player stat not found', { eventId, playerId });
      return null;
    }
  } catch (error) {
    logError('Failed to get player stat', error, { eventId, playerId });
    throw error;
  }
}

// Sync player stats from FPL API for current gameweek
export async function syncCurrentPlayerStats(): Promise<{
  count: number;
  eventId: EventId;
  errors: number;
}> {
  try {
    logInfo('Starting player stats sync for current gameweek');

    // 1. Fetch data from FPL API
    const fplData = await fplClient.getBootstrap();

    if (!fplData.elements || !Array.isArray(fplData.elements)) {
      throw new Error('Invalid player elements data from FPL API');
    }

    if (!fplData.events || !Array.isArray(fplData.events)) {
      throw new Error('Invalid events data from FPL API');
    }

    if (!fplData.teams || !Array.isArray(fplData.teams)) {
      throw new Error('Invalid teams data from FPL API');
    }

    const currentEvent = fplData.events.find((event) => event.is_current);
    if (!currentEvent) {
      throw new Error('No current event found in FPL API response');
    }

    logInfo('Raw player stats data fetched', {
      playersCount: fplData.elements.length,
      eventId: currentEvent.id,
    });

    // 2. Transform the data
    const transformedPlayerStats = transformCurrentGameweekPlayerStats(fplData);
    const errors = fplData.elements.length - transformedPlayerStats.length;

    logInfo('Player stats transformed', {
      total: fplData.elements.length,
      successful: transformedPlayerStats.length,
      errors,
      eventId: currentEvent.id,
    });

    // 3. Batch upsert to database
    const upsertResult = await playerStatsRepository.upsertBatch(transformedPlayerStats);
    logInfo('Player stats upserted to database', { count: upsertResult.count });

    // 4. Update cache with fresh data (latest version only)
    if (upsertResult.count > 0) {
      await playerStatsCache.setByEvent(currentEvent.id, transformedPlayerStats);
      logInfo('Player stats cache updated', {
        eventId: currentEvent.id,
        count: transformedPlayerStats.length,
      });
    }

    const result = {
      count: upsertResult.count,
      eventId: currentEvent.id,
      errors,
    };

    logInfo('Player stats sync completed', result);
    return result;
  } catch (error) {
    logError('Player stats sync failed', error);
    throw error;
  }
}

// Sync player stats for a specific event
export async function syncPlayerStatsForEvent(
  eventId: EventId,
): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting player stats sync for specific event', { eventId });

    // 1. Fetch data from FPL API
    const fplData = await fplClient.getBootstrap();

    if (!fplData.elements || !Array.isArray(fplData.elements)) {
      throw new Error('Invalid player elements data from FPL API');
    }

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

    // 3. Transform the data for the specific event
    const transformedPlayerStats: PlayerStat[] = [];
    const errors: string[] = [];

    for (const element of fplData.elements) {
      try {
        const teamInfo = teamsMap.get(element.team);
        if (!teamInfo) {
          throw new Error(`Team not found for ID: ${element.team}`);
        }

        const playerStat: PlayerStat = {
          eventId,
          elementId: element.id,
          webName: element.web_name,
          elementType: element.element_type as ElementTypeId,
          elementTypeName:
            element.element_type === 1
              ? 'GKP'
              : element.element_type === 2
                ? 'DEF'
                : element.element_type === 3
                  ? 'MID'
                  : 'FWD',
          teamId: element.team,
          teamName: teamInfo.name,
          teamShortName: teamInfo.shortName,
          value: element.now_cost,
          totalPoints: element.total_points,
          form: element.form || null,
          influence: element.influence || null,
          creativity: element.creativity || null,
          threat: element.threat || null,
          ictIndex: element.ict_index || null,
          expectedGoals: element.expected_goals || null,
          expectedAssists: element.expected_assists || null,
          expectedGoalInvolvements: element.expected_goal_involvements || null,
          expectedGoalsConceded: element.expected_goals_conceded || null,
          minutes: element.minutes,
          goalsScored: element.goals_scored,
          assists: element.assists,
          cleanSheets: element.clean_sheets,
          goalsConceded: element.goals_conceded,
          ownGoals: element.own_goals,
          penaltiesSaved: element.penalties_saved,
          yellowCards: element.yellow_cards,
          redCards: element.red_cards,
          saves: element.saves,
          bonus: element.bonus,
          bps: element.bps,
          starts: null,
          influenceRank: null,
          influenceRankType: null,
          creativityRank: null,
          creativityRankType: null,
          threatRank: null,
          threatRankType: null,
          ictIndexRank: null,
          ictIndexRankType: null,
          mngWin: null,
          mngDraw: null,
          mngLoss: null,
          mngUnderdogWin: null,
          mngUnderdogDraw: null,
          mngCleanSheets: null,
          mngGoalsScored: null,
        };

        transformedPlayerStats.push(playerStat);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    logInfo('Player stats transformed for event', {
      total: fplData.elements.length,
      successful: transformedPlayerStats.length,
      errors: errors.length,
      eventId,
    });

    // 4. Batch upsert to database
    const upsertResult = await playerStatsRepository.upsertBatch(transformedPlayerStats);
    logInfo('Player stats upserted to database for event', {
      count: upsertResult.count,
      eventId,
    });

    const result = {
      count: upsertResult.count,
      errors: errors.length,
    };

    logInfo('Player stats sync for event completed', { ...result, eventId });
    return result;
  } catch (error) {
    logError('Player stats sync for event failed', error, { eventId });
    throw error;
  }
}

// Delete player stats for a specific event
export async function deletePlayerStatsByEvent(eventId: EventId): Promise<void> {
  try {
    logInfo('Deleting player stats by event', { eventId });
    await playerStatsRepository.deleteByEventId(eventId);
    logInfo('Player stats deleted by event', { eventId });
  } catch (error) {
    logError('Failed to delete player stats by event', error, { eventId });
    throw error;
  }
}

// Get analytics: top performers by position for an event
export async function getTopPerformersByPosition(
  eventId: EventId,
  limit: number = 10,
): Promise<Record<string, PlayerStat[]>> {
  try {
    logInfo('Getting top performers by position', { eventId, limit });

    const allStats = await getPlayerStatsByEvent(eventId);

    const byPosition = {
      GKP: allStats.filter((stat) => stat.elementTypeName === 'GKP'),
      DEF: allStats.filter((stat) => stat.elementTypeName === 'DEF'),
      MID: allStats.filter((stat) => stat.elementTypeName === 'MID'),
      FWD: allStats.filter((stat) => stat.elementTypeName === 'FWD'),
    };

    // Sort by total points and take top N
    const result = {
      GKP: byPosition.GKP.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0)).slice(
        0,
        limit,
      ),
      DEF: byPosition.DEF.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0)).slice(
        0,
        limit,
      ),
      MID: byPosition.MID.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0)).slice(
        0,
        limit,
      ),
      FWD: byPosition.FWD.sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0)).slice(
        0,
        limit,
      ),
    };

    logInfo('Top performers retrieved', { eventId, limit });
    return result;
  } catch (error) {
    logError('Failed to get top performers by position', error, { eventId, limit });
    throw error;
  }
}

// Get player stats summary/analytics
export async function getPlayerStatsAnalytics(): Promise<{
  totalCount: number;
  latestEventId: EventId | null;
  countsByPosition: Record<string, number>;
}> {
  try {
    logInfo('Getting player stats analytics');

    const [totalCount, latestEventId] = await Promise.all([
      playerStatsRepository.getPlayerStatsCount(),
      playerStatsRepository.getLatestEventId(),
    ]);

    let countsByPosition: Record<string, number> = {
      GKP: 0,
      DEF: 0,
      MID: 0,
      FWD: 0,
    };

    if (latestEventId) {
      const latestStats = await getPlayerStatsByEvent(latestEventId);
      countsByPosition = {
        GKP: latestStats.filter((stat) => stat.elementTypeName === 'GKP').length,
        DEF: latestStats.filter((stat) => stat.elementTypeName === 'DEF').length,
        MID: latestStats.filter((stat) => stat.elementTypeName === 'MID').length,
        FWD: latestStats.filter((stat) => stat.elementTypeName === 'FWD').length,
      };
    }

    const analytics = {
      totalCount,
      latestEventId,
      countsByPosition,
    };

    logInfo('Player stats analytics retrieved', analytics);
    return analytics;
  } catch (error) {
    logError('Failed to get player stats analytics', error);
    throw error;
  }
}
