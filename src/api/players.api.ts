import { Elysia } from 'elysia';

import { syncPlayers } from '../services/players.service';

/**
 * Players API Routes
 *
 * Handles all player operational endpoints:
 * - POST /players/sync - Trigger players sync
 */

export const playersAPI = new Elysia({ prefix: '/players' }).post('/sync', async () => {
  const result = await syncPlayers();
  return { success: true, message: 'Players sync completed', ...result };
});
