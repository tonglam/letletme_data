import { Elysia } from 'elysia';

import { playerStatsCache } from '../cache/operations';
import {
  deletePlayerStatsByEvent,
  getPlayerStat,
  getPlayerStats,
  getPlayerStatsAnalytics,
  getPlayerStatsByEvent,
  getPlayerStatsByPlayer,
  getPlayerStatsByPosition,
  getPlayerStatsByTeam,
  getTopPerformersByPosition,
  syncCurrentPlayerStats,
  syncPlayerStatsForEvent,
} from '../services/player-stats.service';

/**
 * Player Stats API Routes
 *
 * Handles all player stats-related HTTP endpoints:
 * - GET /player-stats - List all player stats (with optional filtering)
 * - GET /player-stats/event/:eventId - Get player stats by event
 * - GET /player-stats/player/:playerId - Get player stats by player
 * - GET /player-stats/team/:teamId - Get player stats by team
 * - GET /player-stats/position/:position - Get player stats by position
 * - GET /player-stats/event/:eventId/player/:playerId - Get specific player stat
 * - GET /player-stats/top/:eventId - Get top performers by position for an event
 * - GET /player-stats/analytics - Get player stats analytics
 * - POST /player-stats/sync - Trigger current player stats sync
 * - POST /player-stats/sync/:eventId - Trigger player stats sync for specific event
 * - DELETE /player-stats/event/:eventId - Delete player stats for an event
 * - DELETE /player-stats/cache - Clear all player stats cache
 * - DELETE /player-stats/cache/:eventId - Clear player stats cache for an event
 */

export const playerStatsAPI = new Elysia({ prefix: '/player-stats' })
  .get('/', async ({ query }) => {
    const { event, player, team, position, limit } = query;

    let stats = await getPlayerStats();

    // Filter by event if requested
    if (event) {
      const eventId = parseInt(event);
      if (!isNaN(eventId)) {
        stats = await getPlayerStatsByEvent(eventId);
      }
    }

    // Filter by player if requested
    if (player) {
      const playerId = parseInt(player);
      if (!isNaN(playerId)) {
        stats = await getPlayerStatsByPlayer(playerId);
      }
    }

    // Filter by team if requested
    if (team) {
      const teamId = parseInt(team);
      if (!isNaN(teamId)) {
        const eventId = event ? parseInt(event) : undefined;
        stats = await getPlayerStatsByTeam(teamId, eventId);
      }
    }

    // Filter by position if requested
    if (position) {
      const positionId = parseInt(position);
      if (!isNaN(positionId) && [1, 2, 3, 4].includes(positionId)) {
        const eventId = event ? parseInt(event) : undefined;
        stats = await getPlayerStatsByPosition(positionId as 1 | 2 | 3 | 4, eventId);
      }
    }

    // Apply limit if requested
    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        stats = stats.slice(0, limitNum);
      }
    }

    return { success: true, data: stats, count: stats.length };
  })

  .get('/event/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      const stats = await getPlayerStatsByEvent(eventId);
      return { success: true, data: stats, count: stats.length };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get player stats for event: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/player/:playerId', async ({ params, set }) => {
    const playerId = parseInt(params.playerId);
    if (isNaN(playerId)) {
      set.status = 400;
      return { success: false, error: 'Invalid player ID' };
    }

    try {
      const stats = await getPlayerStatsByPlayer(playerId);
      return { success: true, data: stats, count: stats.length };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get player stats for player: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/team/:teamId', async ({ params, query, set }) => {
    const teamId = parseInt(params.teamId);
    if (isNaN(teamId)) {
      set.status = 400;
      return { success: false, error: 'Invalid team ID' };
    }

    const eventId = query.event ? parseInt(query.event) : undefined;
    if (query.event && isNaN(eventId!)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      const stats = await getPlayerStatsByTeam(teamId, eventId);
      return { success: true, data: stats, count: stats.length };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get player stats for team: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/position/:position', async ({ params, query, set }) => {
    const position = parseInt(params.position);
    if (isNaN(position) || ![1, 2, 3, 4].includes(position)) {
      set.status = 400;
      return { success: false, error: 'Invalid position (must be 1=GKP, 2=DEF, 3=MID, 4=FWD)' };
    }

    const eventId = query.event ? parseInt(query.event) : undefined;
    if (query.event && isNaN(eventId!)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      const stats = await getPlayerStatsByPosition(position as 1 | 2 | 3 | 4, eventId);
      return { success: true, data: stats, count: stats.length };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get player stats for position: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/event/:eventId/player/:playerId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    const playerId = parseInt(params.playerId);

    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    if (isNaN(playerId)) {
      set.status = 400;
      return { success: false, error: 'Invalid player ID' };
    }

    try {
      const stat = await getPlayerStat(eventId, playerId);
      if (!stat) {
        set.status = 404;
        return { success: false, error: 'Player stat not found' };
      }
      return { success: true, data: stat };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get player stat: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/top/:eventId', async ({ params, query, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const limit = query.limit ? parseInt(query.limit) : 10;
    if (query.limit && (isNaN(limit) || limit <= 0)) {
      set.status = 400;
      return { success: false, error: 'Invalid limit (must be positive number)' };
    }

    try {
      const topPerformers = await getTopPerformersByPosition(eventId, limit);
      return { success: true, data: topPerformers };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get top performers: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .get('/analytics', async ({ set }) => {
    try {
      const analytics = await getPlayerStatsAnalytics();
      return { success: true, data: analytics };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to get analytics: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .post('/sync', async ({ set }) => {
    try {
      const result = await syncCurrentPlayerStats();
      return { success: true, data: result };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Player stats sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .post('/sync/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      const result = await syncPlayerStatsForEvent(eventId);
      return { success: true, data: { ...result, eventId } };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Player stats sync failed for event ${eventId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .delete('/event/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      await deletePlayerStatsByEvent(eventId);
      return { success: true, message: `Player stats deleted for event ${eventId}` };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to delete player stats for event ${eventId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .delete('/cache', async ({ set }) => {
    try {
      await playerStatsCache.clearAll();
      return { success: true, message: 'All player stats cache cleared' };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to clear player stats cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  })

  .delete('/cache/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    try {
      await playerStatsCache.clearByEvent(eventId);
      return { success: true, message: `Player stats cache cleared for event ${eventId}` };
    } catch (error) {
      set.status = 500;
      return {
        success: false,
        error: `Failed to clear player stats cache for event ${eventId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  });
