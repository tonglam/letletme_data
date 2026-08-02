import { getCurrentEvent, getNextEvent } from './events.service';
import type { Event } from '../types';
import { isFPLSeason } from '../utils/conditions';

export type PlayerSyncEvent = {
  event: Event;
  phase: 'preseason' | 'current';
};

export type PlayerSyncEventDependencies = {
  getCurrentEvent: () => Promise<Event | null>;
  getNextEvent: () => Promise<Event | null>;
  isFPLSeason: (date: Date) => Promise<boolean>;
};

const defaultDependencies: PlayerSyncEventDependencies = {
  getCurrentEvent,
  getNextEvent,
  isFPLSeason,
};

/**
 * Player values and stats need GW1 before the ordinary current-event gate opens.
 * Other current-event jobs intentionally continue using shouldRunCurrentEventJob.
 */
export async function resolvePlayerSyncEvent(
  date: Date = new Date(),
  dependencies: PlayerSyncEventDependencies = defaultDependencies,
): Promise<PlayerSyncEvent | null> {
  const [currentEvent, nextEvent, seasonActive] = await Promise.all([
    dependencies.getCurrentEvent(),
    dependencies.getNextEvent(),
    dependencies.isFPLSeason(date),
  ]);

  if (currentEvent && seasonActive) {
    return { event: currentEvent, phase: 'current' };
  }

  if (!currentEvent && nextEvent) {
    return { event: nextEvent, phase: 'preseason' };
  }

  // The GW1 deadline can pass shortly before the first fixture opens the
  // fixture-derived season window. Keep targeting GW1, but retain the
  // once-daily preseason schedule until the season window opens.
  if (currentEvent?.id === 1 && !currentEvent.finished) {
    return { event: currentEvent, phase: 'preseason' };
  }

  return null;
}
