import type { Event, Fixture } from '../types';

const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;
const RESULT_SLOT_MS = 60 * 60 * 1000;

export const POST_MATCH_RESULTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the bounded, idempotent post-match result slot for an event.
 *
 * The first 24 hours after the final fixture are split into hourly provisional
 * slots. Once FPL marks the event data checked, slots become final but remain
 * hourly so later live-data consolidation can publish a corrected snapshot.
 * Callers use the slot in the BullMQ job ID.
 */
export function getPostMatchResultsSlot(
  event: Pick<Event, 'dataChecked'>,
  fixtures: readonly Fixture[],
  date = new Date(),
): string | null {
  const kickoffTimes = fixtures
    .map((fixture) => fixture.kickoffTime?.getTime())
    .filter(
      (kickoffTime): kickoffTime is number =>
        kickoffTime !== undefined && Number.isFinite(kickoffTime),
    );

  if (kickoffTimes.length === 0) {
    return null;
  }

  const matchEndMs = Math.max(...kickoffTimes) + MATCH_DURATION_MS;
  const currentTimeMs = date.getTime();
  if (!Number.isFinite(currentTimeMs)) {
    return null;
  }

  const elapsedMs = currentTimeMs - matchEndMs;
  if (elapsedMs <= 0 || elapsedMs >= POST_MATCH_RESULTS_WINDOW_MS) {
    return null;
  }

  if (event.dataChecked) {
    return `final-${Math.floor(elapsedMs / RESULT_SLOT_MS)}`;
  }

  return `provisional-${Math.floor(elapsedMs / RESULT_SLOT_MS)}`;
}
