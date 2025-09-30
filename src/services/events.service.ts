import { eventsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { eventRepository } from '../repositories/events';
import { transformEvents } from '../transformers/events';
import type { Event } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Events Service - Business Logic Layer
 *
 * Handles all event-related operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

// Get all events (cache-first strategy: Redis → DB → update Redis)
export async function getEvents(): Promise<Event[]> {
  try {
    logInfo('Getting all events');

    // 1. Try cache first (fast path)
    const cached = await eventsCache.getAll();
    if (cached) {
      logInfo('Events retrieved from cache', { count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const dbEvents = await eventRepository.findAll();

    // 3. Update cache for next time (async, don't block response)
    if (dbEvents.length > 0) {
      eventsCache.set(dbEvents).catch((error) => {
        logError('Failed to update events cache', error);
      });
    }

    logInfo('Events retrieved from database', { count: dbEvents.length });
    return dbEvents;
  } catch (error) {
    logError('Failed to get events', error);
    throw error;
  }
}

// Get single event by ID (cache-first strategy: Redis → DB → update Redis)
export async function getEvent(id: number): Promise<Event | null> {
  try {
    logInfo('Getting event by id', { id });

    // 1. Try cache first (fast path)
    const cached = await eventsCache.getById(id);
    if (cached) {
      logInfo('Event retrieved from cache', { id });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { id });
    const event = await eventRepository.findById(id);

    if (event) {
      // 3. Update cache for next time (async, don't block response)
      eventsCache.getAll().then((allEvents) => {
        if (!allEvents) {
          // If full cache doesn't exist, fetch all and cache
          eventRepository.findAll().then((dbEvents) => {
            eventsCache.set(dbEvents).catch((error) => {
              logError('Failed to update events cache', error);
            });
          });
        }
      });

      logInfo('Event found in database', { id });
    } else {
      logInfo('Event not found', { id });
    }

    return event;
  } catch (error) {
    logError('Failed to get event', error, { id });
    throw error;
  }
}

// Get current event (cache-first strategy: Redis → DB → update Redis)
export async function getCurrentEvent(): Promise<Event | null> {
  try {
    logInfo('Getting current event');

    // 1. Try cache first (fast path)
    const cached = await eventsCache.getCurrent();
    if (cached) {
      logInfo('Current event retrieved from cache', { id: cached.id });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const event = await eventRepository.findCurrent();

    if (event) {
      // 3. Update cache for next time (async, don't block response)
      eventsCache.getAll().then((allEvents) => {
        if (!allEvents) {
          eventRepository.findAll().then((dbEvents) => {
            eventsCache.set(dbEvents).catch((error) => {
              logError('Failed to update events cache', error);
            });
          });
        }
      });

      logInfo('Current event found in database', { id: event.id });
    } else {
      logInfo('No current event found');
    }

    return event;
  } catch (error) {
    logError('Failed to get current event', error);
    throw error;
  }
}

// Get next event (cache-first strategy: Redis → DB → update Redis)
export async function getNextEvent(): Promise<Event | null> {
  try {
    logInfo('Getting next event');

    // 1. Try cache first (fast path)
    const cached = await eventsCache.getNext();
    if (cached) {
      logInfo('Next event retrieved from cache', { id: cached.id });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const event = await eventRepository.findNext();

    if (event) {
      // 3. Update cache for next time (async, don't block response)
      eventsCache.getAll().then((allEvents) => {
        if (!allEvents) {
          eventRepository.findAll().then((dbEvents) => {
            eventsCache.set(dbEvents).catch((error) => {
              logError('Failed to update events cache', error);
            });
          });
        }
      });

      logInfo('Next event found in database', { id: event.id });
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
export async function syncEvents(): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting events sync from FPL API');

    // 1. Fetch from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    if (!bootstrapData.events || !Array.isArray(bootstrapData.events)) {
      throw new Error('Invalid events data from FPL API');
    }

    logInfo('Raw events data fetched', { count: bootstrapData.events.length });

    // 2. Transform to domain events
    const events = transformEvents(bootstrapData.events);
    logInfo('Events transformed', {
      total: bootstrapData.events.length,
      successful: events.length,
      errors: bootstrapData.events.length - events.length,
    });

    // 3. Save to database (batch upsert)
    const savedEvents = await eventRepository.upsertBatch(events);
    logInfo('Events upserted to database', { count: savedEvents.length });

    // 4. Update cache with full event objects
    await eventsCache.set(savedEvents);
    logInfo('Events cache updated');

    const result = {
      count: savedEvents.length,
      errors: bootstrapData.events.length - events.length,
    };

    logInfo('Events sync completed successfully', result);
    return result;
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
