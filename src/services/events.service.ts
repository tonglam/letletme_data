import { eventsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { eventRepository } from '../repositories/events';
import { transformEvents } from '../transformers/events';
import { resolvePublishedSeasonFromEvents } from './cache-season.service';
import type { Event } from '../types';
import { logDebug, logError, logInfo } from '../utils/logger';

/**
 * Events Service - Business Logic Layer
 *
 * Handles all event-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 * - Current/next event retrieval with fallbacks
 */

// Get current event (cache-first strategy: Redis → DB fallback)
export async function getCurrentEvent(): Promise<Event | null> {
  try {
    const cached = await eventsCache.getCurrent();
    if (cached) {
      logDebug('Current event retrieved from cache', { id: cached.id });
      return cached;
    }

    logDebug('Current event cache miss - fetching from database');
    const event = await eventRepository.findCurrent();
    logDebug('Current event fetched from database', { id: event?.id ?? null });
    return event;
  } catch (error) {
    logError('Failed to get current event', error);
    throw error;
  }
}

// Get next event (cache-first strategy: Redis → DB fallback)
export async function getNextEvent(): Promise<Event | null> {
  try {
    const cached = await eventsCache.getNext();
    if (cached) {
      logDebug('Next event retrieved from cache', { id: cached.id });
      return cached;
    }

    logDebug('Next event cache miss - fetching from database');
    const event = await eventRepository.findNext();
    logDebug('Next event fetched from database', { id: event?.id ?? null });
    return event;
  } catch (error) {
    logError('Failed to get next event', error);
    throw error;
  }
}

// Get previous event (cache-first strategy: Redis → DB fallback)
export async function getPreviousEvent(): Promise<Event | null> {
  try {
    const cached = await eventsCache.getPrevious();
    if (cached) {
      logDebug('Previous event retrieved from cache', { id: cached.id });
      return cached;
    }

    logDebug('Previous event cache miss - fetching from database');
    const event = await eventRepository.findPrevious();
    logDebug('Previous event fetched from database', { id: event?.id ?? null });
    return event;
  } catch (error) {
    logError('Failed to get previous event', error);
    throw error;
  }
}

// Sync events from FPL API
export async function syncEvents(): Promise<{
  count: number;
  errors: number;
  warningCount: number;
}> {
  try {
    logInfo('Starting events sync from FPL API');
    const syncStart = Date.now();

    // 1. Fetch from FPL API
    const fetchStart = Date.now();
    const bootstrapData = await fplClient.getBootstrap();
    const fetchDuration = Date.now() - fetchStart;
    logInfo('Events sync stage completed', { stage: 'fetch', durationMs: fetchDuration });

    if (!bootstrapData.events || !Array.isArray(bootstrapData.events)) {
      throw new Error('Invalid events data from FPL API');
    }

    logInfo('Raw events data fetched', { count: bootstrapData.events.length });

    if (bootstrapData.events.length === 0) {
      logInfo('No events returned from FPL API; preserving existing events cache');
      return {
        count: 0,
        errors: 0,
        warningCount: 0,
      };
    }

    // 2. Transform to domain events (transformer validates each record via Zod)
    const transformStart = Date.now();
    const events = transformEvents(bootstrapData.events);
    const transformDuration = Date.now() - transformStart;
    const transformErrors = bootstrapData.events.length - events.length;

    logInfo('Events transformed', {
      total: bootstrapData.events.length,
      successful: events.length,
      skipped: transformErrors,
      durationMs: transformDuration,
    });

    // 3. Save to database (batch upsert)
    const dbStart = Date.now();
    const savedEvents = await eventRepository.upsertBatch(events);
    const dbDuration = Date.now() - dbStart;
    logInfo('Events upserted to database', { count: savedEvents.length });
    logInfo('Events sync stage completed', { stage: 'database', durationMs: dbDuration });

    // 4. Update cache with full event objects
    const cacheStart = Date.now();
    await eventsCache.set(
      savedEvents,
      await resolvePublishedSeasonFromEvents(bootstrapData.events),
    );
    const cacheDuration = Date.now() - cacheStart;
    logInfo('Events cache updated', { durationMs: cacheDuration });

    const result = {
      count: savedEvents.length,
      errors: transformErrors,
      warningCount: 0,
    };

    logInfo('Events sync completed successfully', {
      ...result,
      totalDurationMs: Date.now() - syncStart,
    });
    return result;
  } catch (error) {
    logError('Events sync failed', error);
    throw error;
  }
}
