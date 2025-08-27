import { Elysia } from 'elysia';

import {
  clearPlayersCache,
  getPlayer,
  getPlayers,
  getPlayersByTeam,
  syncPlayers,
} from '../services/players.service';

/**
 * Players API Routes
 *
 * Handles all player-related HTTP endpoints:
 * - GET /players - List all players (with optional filtering)
 * - GET /players/:id - Get specific player
 * - POST /players/sync - Trigger players sync
 * - DELETE /players/cache - Clear players cache
 */

export const playersAPI = new Elysia({ prefix: '/players' })
  .get('/', async ({ query }) => {
    const { team, limit } = query;

    let players = await getPlayers();

    // Filter by team if requested
    if (team) {
      const teamId = parseInt(team);
      if (!isNaN(teamId)) {
        players = await getPlayersByTeam(teamId);
      }
    }

    // Apply limit if requested
    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        players = players.slice(0, limitNum);
      }
    }

    return { success: true, data: players, count: players.length };
  })

  .get('/:id', async ({ params, set }) => {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      set.status = 400;
      return { success: false, error: 'Invalid player ID' };
    }

    const player = await getPlayer(id);
    if (!player) {
      set.status = 404;
      return { success: false, error: 'Player not found' };
    }

    return { success: true, data: player };
  })

  .post('/sync', async () => {
    const result = await syncPlayers();
    return { success: true, message: 'Players sync completed', ...result };
  })

  .delete('/cache', async () => {
    await clearPlayersCache();
    return { success: true, message: 'Players cache cleared' };
  });
