import { Elysia } from 'elysia';

import { syncEvents } from '../services/events.service';

/**
 * Events API Routes
 *
 * Handles all event-related HTTP endpoints:
 * - POST /events/sync - Trigger events sync
 */

export const eventsAPI = new Elysia({ prefix: '/events' }).post('/sync', async () => {
  const result = await syncEvents();
  return { success: true, message: 'Events sync completed', ...result };
});
