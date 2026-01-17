import { Elysia } from 'elysia';

import { syncCurrentPlayerStats, syncPlayerStatsForEvent } from '../services/player-stats.service';

/**
 * Player Stats API Routes
 *
 * Handles player stats operational endpoints:
 * - POST /player-stats/sync - Trigger current player stats sync
 * - POST /player-stats/sync/:eventId - Trigger player stats sync for specific event
 */

export const playerStatsAPI = new Elysia({ prefix: '/player-stats' })
  .post('/sync', async () => {
    const result = await syncCurrentPlayerStats();
    return { success: true, data: result };
  })

  .post('/sync/:eventId', async ({ params }) => {
    const eventId = parseInt(params.eventId);

    if (Number.isNaN(eventId)) {
      throw new Error('Invalid event ID');
    }

    const result = await syncPlayerStatsForEvent(eventId);
    return { success: true, data: { ...result, eventId } };
  });
