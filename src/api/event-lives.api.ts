import { Elysia } from 'elysia';

import {
  clearAllEventLivesCache,
  clearEventLivesCache,
  getEventLiveByEventAndElement,
  getEventLivesByElementId,
  getEventLivesByEventId,
  syncEventLives,
} from '../services/event-lives.service';

/**
 * Event Lives API Routes
 *
 * Handles all event live data HTTP endpoints:
 * - GET /event-lives/event/:eventId - Get all live data for a specific event
 * - GET /event-lives/event/:eventId/element/:elementId - Get live data for a specific player in an event
 * - GET /event-lives/element/:elementId - Get all live data for a specific player across events
 * - POST /event-lives/sync/:eventId - Trigger event live sync for a specific event
 * - DELETE /event-lives/cache/:eventId - Clear cache for a specific event
 * - DELETE /event-lives/cache - Clear all event lives cache
 */

export const eventLivesAPI = new Elysia({ prefix: '/event-lives' })
  // Get all event live data for a specific event
  .get('/event/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const eventLives = await getEventLivesByEventId(eventId);
    return { success: true, data: eventLives, count: eventLives.length };
  })

  // Get event live data for a specific player in a specific event
  .get('/event/:eventId/element/:elementId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    const elementId = parseInt(params.elementId);

    if (isNaN(eventId) || isNaN(elementId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID or element ID' };
    }

    const eventLive = await getEventLiveByEventAndElement(eventId, elementId);
    if (!eventLive) {
      set.status = 404;
      return { success: false, error: 'Event live data not found' };
    }

    return { success: true, data: eventLive };
  })

  // Get all event live data for a specific player across events
  .get('/element/:elementId', async ({ params, set }) => {
    const elementId = parseInt(params.elementId);
    if (isNaN(elementId)) {
      set.status = 400;
      return { success: false, error: 'Invalid element ID' };
    }

    const eventLives = await getEventLivesByElementId(elementId);
    return { success: true, data: eventLives, count: eventLives.length };
  })

  // Sync event live data from FPL API for a specific event
  .post('/sync/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const result = await syncEventLives(eventId);
    return {
      success: true,
      message: `Event live sync completed for event ${eventId}`,
      ...result,
    };
  })

  // Clear cache for a specific event
  .delete('/cache/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    await clearEventLivesCache(eventId);
    return { success: true, message: `Event lives cache cleared for event ${eventId}` };
  })

  // Clear all event lives cache
  .delete('/cache', async () => {
    await clearAllEventLivesCache();
    return { success: true, message: 'All event lives cache cleared' };
  });
