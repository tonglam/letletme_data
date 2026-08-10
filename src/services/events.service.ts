import {
  readCoreSnapshotCache,
  type CoreSnapshotCacheContents,
} from '../cache/core-snapshot-cache';
import { neighbourEventId, normalizeEventDeadline } from '../domain/events';
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
export function selectCachedCurrentEvent(
  publication: Pick<CoreSnapshotCacheContents, 'currentEventId' | 'events'>,
): Event | null {
  if (publication.currentEventId === null) return null;
  return publication.events.find((event) => event.id === publication.currentEventId) ?? null;
}

export function selectCachedEventNeighbour(
  publication: Pick<CoreSnapshotCacheContents, 'currentEventId' | 'events' | 'manifest'>,
  offset: -1 | 1,
): Event | null {
  if (publication.currentEventId === null) {
    if (offset === -1) return null;
    const checkedAt = new Date(publication.manifest.sourceCheckedAt).getTime();
    const deadline = (event: Event): number =>
      event.deadlineTime ? new Date(event.deadlineTime).getTime() : Number.POSITIVE_INFINITY;
    return (
      publication.events
        .filter((event) => deadline(event) > checkedAt)
        .sort((left, right) => deadline(left) - deadline(right))[0] ?? null
    );
  }

  const targetId = neighbourEventId(publication.currentEventId, offset);
  if (targetId === null) return null;
  return publication.events.find((event) => event.id === targetId) ?? null;
}

export async function getCurrentEvent(season: FplSeasonRef): Promise<Event | null> {
  try {
    const publication = await readCoreSnapshotCache(season.seasonCode);
    const cached = publication ? selectCachedCurrentEvent(publication) : null;
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
    const cached = publication ? selectCachedEventNeighbour(publication, 1) : null;
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
    const cached = publication ? selectCachedEventNeighbour(publication, -1) : null;
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
