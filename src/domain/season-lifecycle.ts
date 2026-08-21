import type { Event } from '../types';

export type FplLifecycleState = 'reference_only' | 'completed' | 'preseason' | 'active' | 'closed';

/**
 * Advance the season lifecycle from official event evidence only. This is
 * deliberately one-way: a transient bootstrap/cache gap must not move an
 * active or completed season back into preseason.
 */
export function advanceSeasonLifecycleState(
  currentState: string,
  events: ReadonlyArray<Pick<Event, 'id' | 'finished' | 'dataChecked' | 'isCurrent'>>,
): FplLifecycleState {
  if (currentState === 'reference_only' || currentState === 'closed') {
    return currentState;
  }

  const gw38 = events.find((event) => event.id === 38);
  if (gw38?.finished && gw38.dataChecked) {
    return 'completed';
  }

  if (currentState === 'preseason' && events.some((event) => event.isCurrent || event.finished)) {
    return 'active';
  }

  if (currentState === 'completed') return 'completed';
  if (currentState === 'active') return 'active';
  return 'preseason';
}
