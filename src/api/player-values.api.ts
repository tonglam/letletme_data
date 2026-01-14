import { Elysia } from 'elysia';

import { playerValuesCache } from '../cache/operations';
import {
  deletePlayerValuesByEvent,
  getFilteredAndSortedPlayerValues,
  getPlayerValue,
  getPlayerValuesAnalytics,
  getPlayerValuesByChangeType,
  getPlayerValuesByEvent,
  getPlayerValuesByPlayer,
  getPlayerValuesByDate,
  getPlayerValuesByPosition,
  getPlayerValuesByTeam,
  getPlayerValuesCount,
  getTopValueFallersForEvent,
  getTopValueRisersForEvent,
  syncCurrentPlayerValues,
  syncPlayerValuesForEvent,
} from '../services/player-values.service';

/**
 * Player Values API Routes
 *
 * Handles all player values-related HTTP endpoints:
 * - GET /player-values - List all player values (with optional filtering)
 * - GET /player-values/event/:eventId - Get player values by event
 * - GET /player-values/player/:playerId - Get player values by player
 * - GET /player-values/team/:teamId - Get player values by team
 * - GET /player-values/position/:position - Get player values by position
 * - GET /player-values/change-type/:changeType - Get player values by change type
 * - GET /player-values/event/:eventId/player/:playerId - Get specific player value
 * - GET /player-values/risers/:eventId - Get top value risers for an event
 * - GET /player-values/fallers/:eventId - Get top value fallers for an event
 * - GET /player-values/analytics - Get player values analytics
 * - GET /player-values/count - Get total player values count
 * - POST /player-values/sync - Trigger current player values sync
 * - POST /player-values/sync/:eventId - Trigger player values sync for specific event
 * - DELETE /player-values/event/:eventId - Delete player values for an event
 * - DELETE /player-values/cache - Clear all player values cache
 * - DELETE /player-values/cache/:eventId - Clear player values cache for an event
 */

export const playerValuesAPI = new Elysia({ prefix: '/player-values' })
  .get('/', async ({ query }) => {
    const { event, team, position, changeType, sortBy, limit } = query;

    // Parse query parameters
    const filters = {
      eventId: event ? parseInt(event) : undefined,
      teamId: team ? parseInt(team) : undefined,
      position: position ? (parseInt(position) as 1 | 2 | 3 | 4) : undefined,
      changeType: changeType as 'increase' | 'decrease' | 'stable' | 'unknown' | undefined,
    };

    // Remove undefined filters
    const cleanFilters = Object.fromEntries(
      Object.entries(filters).filter(([_, value]) => value !== undefined),
    );

    const parsedLimit = limit ? parseInt(limit) : undefined;

    const data = await getFilteredAndSortedPlayerValues(
      cleanFilters,
      sortBy as 'value' | 'change' | 'name' | undefined,
      parsedLimit,
    );
    return Response.json(data);
  })

  .get('/event/:eventId', async ({ params }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }
    const data = await getPlayerValuesByEvent(eventId);
    return Response.json(data);
  })

  .get('/player/:playerId', async ({ params }) => {
    const playerId = parseInt(params.playerId);
    if (isNaN(playerId)) {
      throw new Error('Invalid player ID');
    }
    const data = await getPlayerValuesByPlayer(playerId);
    return Response.json(data);
  })

  .get('/team/:teamId', async ({ params, query }) => {
    const teamId = parseInt(params.teamId);
    const eventId = query.event ? parseInt(query.event) : undefined;

    if (isNaN(teamId)) {
      throw new Error('Invalid team ID');
    }
    if (eventId && isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const data = await getPlayerValuesByTeam(teamId, eventId);
    return Response.json(data);
  })

  .get('/date/:changeDate', async ({ params }) => {
    const { changeDate } = params;
    if (!/^\d{8}$/.test(changeDate)) {
      throw new Error('Invalid change date (must be YYYYMMDD)');
    }
    const data = await getPlayerValuesByDate(changeDate);
    return Response.json(data);
  })

  .get('/position/:position', async ({ params, query }) => {
    const position = parseInt(params.position) as 1 | 2 | 3 | 4;
    const eventId = query.event ? parseInt(query.event) : undefined;

    if (![1, 2, 3, 4].includes(position)) {
      throw new Error('Invalid position (must be 1-4)');
    }
    if (eventId && isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const data = await getPlayerValuesByPosition(position, eventId);
    return Response.json(data);
  })

  .get('/change-type/:changeType', async ({ params, query }) => {
    const { changeType } = params;
    const eventId = query.event ? parseInt(query.event) : undefined;

    if (!['increase', 'decrease', 'stable', 'unknown'].includes(changeType)) {
      throw new Error('Invalid change type');
    }
    if (eventId && isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const data = await getPlayerValuesByChangeType(
      changeType as 'increase' | 'decrease' | 'stable' | 'unknown',
      eventId,
    );
    return Response.json(data);
  })

  .get('/event/:eventId/player/:playerId', async ({ params }) => {
    const eventId = parseInt(params.eventId);
    const playerId = parseInt(params.playerId);

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }
    if (isNaN(playerId)) {
      throw new Error('Invalid player ID');
    }

    const playerValue = await getPlayerValue(eventId, playerId);
    if (!playerValue) {
      throw new Error('Player value not found');
    }

    return Response.json(playerValue);
  })

  .get('/risers/:eventId', async ({ params, query }) => {
    const eventId = parseInt(params.eventId);
    const limit = query.limit ? parseInt(query.limit) : 10;

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }
    if (limit && (isNaN(limit) || limit <= 0)) {
      throw new Error('Invalid limit (must be positive number)');
    }

    const data = await getTopValueRisersForEvent(eventId, limit);
    return Response.json(data);
  })

  .get('/fallers/:eventId', async ({ params, query }) => {
    const eventId = parseInt(params.eventId);
    const limit = query.limit ? parseInt(query.limit) : 10;

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }
    if (limit && (isNaN(limit) || limit <= 0)) {
      throw new Error('Invalid limit (must be positive number)');
    }

    const data = await getTopValueFallersForEvent(eventId, limit);
    return Response.json(data);
  })

  .get('/analytics', async ({ query }) => {
    const eventId = query.event ? parseInt(query.event) : undefined;

    if (eventId && isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const data = await getPlayerValuesAnalytics(eventId);
    return Response.json(data);
  })

  .get('/count', async () => {
    return Response.json({ count: await getPlayerValuesCount() });
  })

  .post('/sync', async () => {
    const result = await syncCurrentPlayerValues();
    return {
      success: true,
      message: 'Current player values sync completed',
      data: result,
    };
  })

  .post('/sync/:eventId', async ({ params }) => {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const result = await syncPlayerValuesForEvent(eventId);
    return {
      success: true,
      message: `Player values sync completed for event ${eventId}`,
      data: result,
    };
  })

  .delete('/event/:eventId', async ({ params }) => {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    await deletePlayerValuesByEvent(eventId);
    return {
      success: true,
      message: `Player values deleted for event ${eventId}`,
    };
  })

  .delete('/cache', async () => {
    await playerValuesCache.clearAll();
    return {
      success: true,
      message: 'All player values cache cleared',
    };
  })

  .delete('/cache/:eventId', async ({ params }) => {
    const eventId = parseInt(params.eventId);

    if (isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    await playerValuesCache.clearByEvent(eventId);
    return {
      success: true,
      message: `Player values cache cleared for event ${eventId}`,
    };
  });
