import { eventsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { eventRepository } from '../repositories/events';
import { transformEvents } from '../transformers/events';
import { getErrorMessage, getErrorStatus } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Request, Response } from 'express';
import type { Event } from '../types';

/**
 * Simplified Events Service
 * Direct approach: Fetch -> Transform -> Save -> Cache
 */

// Get all events (with cache fallback)
export async function getEvents(): Promise<Event[]> {
  try {
    logInfo('Getting all events');

    // Try cache first
    const cached = await eventsCache.get();
    if (cached) {
      logInfo('Events retrieved from cache', { count: Array.isArray(cached) ? cached.length : 0 });
      return cached as Event[];
    }

    // Fallback to database
    const dbEvents = await eventRepository.findAll();

    // Update cache for next time
    if (dbEvents.length > 0) {
      await eventsCache.set(dbEvents);
    }

    logInfo('Events retrieved from database', { count: dbEvents.length });
    return dbEvents;
  } catch (error) {
    logError('Failed to get events', error);
    throw error;
  }
}

// Get single event by ID
export async function getEvent(id: number): Promise<Event | null> {
  try {
    logInfo('Getting event by id', { id });

    const event = await eventRepository.findById(id);

    if (event) {
      logInfo('Event found', { id });
    } else {
      logInfo('Event not found', { id });
    }

    return event;
  } catch (error) {
    logError('Failed to get event', error, { id });
    throw error;
  }
}

// Get current event
export async function getCurrentEvent(): Promise<Event | null> {
  try {
    logInfo('Getting current event');

    const event = await eventRepository.findCurrent();

    if (event) {
      logInfo('Current event found', { id: event.id });
    } else {
      logInfo('No current event found');
    }

    return event;
  } catch (error) {
    logError('Failed to get current event', error);
    throw error;
  }
}

// Get next event
export async function getNextEvent(): Promise<Event | null> {
  try {
    logInfo('Getting next event');

    const event = await eventRepository.findNext();

    if (event) {
      logInfo('Next event found', { id: event.id });
    } else {
      logInfo('No next event found');
    }

    return event;
  } catch (error) {
    logError('Failed to get next event', error);
    throw error;
  }
}

// Sync events from FPL API
export async function syncEvents(): Promise<void> {
  try {
    logInfo('Starting events sync from FPL API');

    // 1. Fetch from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    // 2. Transform to domain events
    const events = transformEvents(bootstrapData.events);

    // 3. Save to database (batch upsert)
    await eventRepository.upsertBatch(events);

    // 4. Update cache with raw deadline_time data (matching Java pattern)
    await eventsCache.setRaw(bootstrapData.events);

    logInfo('Events sync completed successfully', { count: events.length });
  } catch (error) {
    logError('Events sync failed', error);
    throw error;
  }
}

// Clear events cache
export async function clearEventsCache(): Promise<void> {
  try {
    logInfo('Clearing events cache');
    await eventsCache.clear();
    logInfo('Events cache cleared');
  } catch (error) {
    logError('Failed to clear events cache', error);
    throw error;
  }
}

// Event API endpoints for HTTP server
export const eventsAPI = {
  // GET /events
  async getAllEvents(req: Request, res: Response) {
    try {
      const events = await getEvents();
      res.json({ success: true, data: events });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // GET /events/:id
  async getEventById(req: Request, res: Response) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid event ID' });
      }

      const event = await getEvent(id);
      if (!event) {
        return res.status(404).json({ success: false, error: 'Event not found' });
      }

      res.json({ success: true, data: event });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // GET /events/current
  async getCurrentEvent(req: Request, res: Response) {
    try {
      const event = await getCurrentEvent();
      if (!event) {
        return res.status(404).json({ success: false, error: 'No current event found' });
      }

      res.json({ success: true, data: event });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // GET /events/next
  async getNextEvent(req: Request, res: Response) {
    try {
      const event = await getNextEvent();
      if (!event) {
        return res.status(404).json({ success: false, error: 'No next event found' });
      }

      res.json({ success: true, data: event });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // POST /events/sync
  async syncEvents(req: Request, res: Response) {
    try {
      await syncEvents();
      res.json({ success: true, message: 'Events synced successfully' });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // DELETE /events/cache
  async clearCache(req: Request, res: Response) {
    try {
      await clearEventsCache();
      res.json({ success: true, message: 'Events cache cleared' });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },
};
