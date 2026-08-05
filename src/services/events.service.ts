import { eventsCache } from '../cache/operations';
import { normalizeEventDeadline } from '../domain/events';
import { eventRepository } from '../repositories/events';
import { syncCoreSnapshot } from './core-snapshot.service';
import type { Event } from '../types';
import { logDebug, logError } from '../utils/logger';

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
      return normalizeEventDeadline(cached);
    }

    logDebug('Current event cache miss - fetching from database');
    const event = await eventRepository.findCurrent();
    logDebug('Current event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
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
      return normalizeEventDeadline(cached);
    }

    logDebug('Next event cache miss - fetching from database');
    const event = await eventRepository.findNext();
    logDebug('Next event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
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
      return normalizeEventDeadline(cached);
    }

    logDebug('Previous event cache miss - fetching from database');
    const event = await eventRepository.findPrevious();
    logDebug('Previous event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
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
  const result = await syncCoreSnapshot();
  return {
    count: result.events,
    errors: result.failedUnits,
    warningCount: 0,
  };
}
