import { getCurrentEvent, getNextEvent } from './events.service';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { Event } from '../types';

export type PlayerSyncEvent = {
  event: Event;
  phase: 'preseason' | 'current';
};

export type PlayerSyncEventDependencies = {
  getCurrentEvent: (season: FplSeasonRef) => Promise<Event | null>;
  getNextEvent: (season: FplSeasonRef) => Promise<Event | null>;
};

const defaultDependencies: PlayerSyncEventDependencies = {
  getCurrentEvent,
  getNextEvent,
};

/**
 * Player values and stats need GW1 before the ordinary current-event gate opens.
 * Other current-event jobs intentionally continue using shouldRunCurrentEventJob.
 */
export async function resolvePlayerSyncEvent(
  season: FplSeasonRef,
  _date: Date = new Date(),
  dependencies: PlayerSyncEventDependencies = defaultDependencies,
): Promise<PlayerSyncEvent | null> {
  const [currentEvent, nextEvent] = await Promise.all([
    dependencies.getCurrentEvent(season),
    dependencies.getNextEvent(season),
  ]);

  if (currentEvent) {
    return { event: currentEvent, phase: 'current' };
  }

  if (!currentEvent && nextEvent) {
    return { event: nextEvent, phase: 'preseason' };
  }

  return null;
}
