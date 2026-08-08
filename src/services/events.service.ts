import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { normalizeEventDeadline } from '../domain/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import { eventRepository } from '../repositories/events';
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
export async function getCurrentEvent(season: FplSeasonRef): Promise<Event | null> {
  try {
    const publication = await readCoreSnapshotCache(season.seasonCode);
    const cached = publication
      ? (publication.events.find((event) => event.id === publication.currentEventId) ??
        publication.events.find((event) => event.isCurrent))
      : null;
    if (cached) {
      logDebug('Current event retrieved from cache', { id: cached.id });
      return normalizeEventDeadline(cached);
    }

    logDebug('Current event cache miss - fetching from database');
    const event = await eventRepository.findCurrent(season);
    logDebug('Current event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
  } catch (error) {
    logError('Failed to get current event', error);
    throw error;
  }
}

// Get next event (cache-first strategy: Redis → DB fallback)
export async function getNextEvent(season: FplSeasonRef): Promise<Event | null> {
  try {
    const publication = await readCoreSnapshotCache(season.seasonCode);
    const cached = publication?.events.find((event) => event.isNext) ?? null;
    if (cached) {
      logDebug('Next event retrieved from cache', { id: cached.id });
      return normalizeEventDeadline(cached);
    }

    logDebug('Next event cache miss - fetching from database');
    const event = await eventRepository.findNext(season);
    logDebug('Next event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
  } catch (error) {
    logError('Failed to get next event', error);
    throw error;
  }
}

// Get previous event (cache-first strategy: Redis → DB fallback)
export async function getPreviousEvent(season: FplSeasonRef): Promise<Event | null> {
  try {
    const publication = await readCoreSnapshotCache(season.seasonCode);
    const cached = publication?.events.find((event) => event.isPrevious) ?? null;
    if (cached) {
      logDebug('Previous event retrieved from cache', { id: cached.id });
      return normalizeEventDeadline(cached);
    }

    logDebug('Previous event cache miss - fetching from database');
    const event = await eventRepository.findPrevious(season);
    logDebug('Previous event fetched from database', { id: event?.id ?? null });
    return event ? normalizeEventDeadline(event) : null;
  } catch (error) {
    logError('Failed to get previous event', error);
    throw error;
  }
}
