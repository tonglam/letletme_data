import { Elysia } from 'elysia';

import { syncCurrentPlayerValues } from '../services/player-values.service';

/**
 * Player Values API Routes
 *
 * Handles player values operational endpoints:
 * - POST /player-values/sync - Trigger current player values sync (checks today's date for changes)
 *
 * Player values are date-based (changeDate), tracking price changes by date.
 * Each record is uniquely identified by (elementId, changeDate).
 */

export const playerValuesAPI = new Elysia({ prefix: '/player-values' }).post('/sync', async () => {
  const result = await syncCurrentPlayerValues();
  return {
    success: true,
    message: 'Current player values sync completed',
    data: result,
  };
});
