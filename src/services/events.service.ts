import { eventsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { eventRepository } from '../repositories/events';
import { transformEvents } from '../transformers/events';
import type { Event } from '../types';
import { logError, logInfo, logWarn } from '../utils/logger';

type EventValidationIssue = {
  eventId: number;
  issues: string[];
};

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

// Get next event (cache-first strategy: Redis → DB fallback)
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

    const validationIssues: EventValidationIssue[] = [];

    for (const event of bootstrapData.events) {
      const issues: string[] = [];
      if (!Number.isInteger(event.id) || event.id < 1) {
        issues.push('id');
      }

      if (typeof event.name !== 'string' || event.name.trim().length === 0) {
        issues.push('name');
      }

      if (event.deadline_time) {
        const deadline = new Date(event.deadline_time);
        if (Number.isNaN(deadline.getTime())) {
          issues.push('deadline_time');
        }
      }

      if (issues.length > 0) {
        validationIssues.push({ eventId: event.id, issues });
      }
    }

    if (validationIssues.length > 0) {
      logWarn('Events sync validation warnings', {
        issueCount: validationIssues.length,
        sample: validationIssues.slice(0, 5),
      });
    }

    // 2. Transform to domain events
    const transformStart = Date.now();
    const events = transformEvents(bootstrapData.events);
    const transformDuration = Date.now() - transformStart;
    const transformErrors = bootstrapData.events.length - events.length;

    logInfo('Events transformed', {
      total: bootstrapData.events.length,
      successful: events.length,
      transformErrors,
      validationWarnings: validationIssues.length,
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
    await eventsCache.set(savedEvents);
    const cacheDuration = Date.now() - cacheStart;
    logInfo('Events cache updated', { durationMs: cacheDuration });

    const result = {
      count: savedEvents.length,
      errors: transformErrors + validationIssues.length,
      warningCount: validationIssues.length,
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
