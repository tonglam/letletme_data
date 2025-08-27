import { Elysia } from 'elysia';

import {
  clearEventsCache,
  getCurrentEvent,
  getEvent,
  getEvents,
  getNextEvent,
  syncEvents,
} from '../services/events.service';

/**
 * Events API Routes
 *
 * Handles all event-related HTTP endpoints:
 * - GET /events - List all events
 * - GET /events/current - Get current event
 * - GET /events/next - Get next event
 * - GET /events/:id - Get specific event
 * - POST /events/sync - Trigger events sync
 * - DELETE /events/cache - Clear events cache
 */

export const eventsAPI = new Elysia({ prefix: '/events' })
  .get('/', async () => {
    const events = await getEvents();
    return { success: true, data: events, count: events.length };
  })

  .get('/current', async () => {
    const event = await getCurrentEvent();
    return { success: true, data: event };
  })

  .get('/next', async () => {
    const event = await getNextEvent();
    return { success: true, data: event };
  })

  .get('/:id', async ({ params, set }) => {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const event = await getEvent(id);
    if (!event) {
      set.status = 404;
      return { success: false, error: 'Event not found' };
    }

    return { success: true, data: event };
  })

  .post('/sync', async () => {
    const result = await syncEvents();
    return { success: true, message: 'Events sync completed', ...result };
  })

  .delete('/cache', async () => {
    await clearEventsCache();
    return { success: true, message: 'Events cache cleared' };
  });
