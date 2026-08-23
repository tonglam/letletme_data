import type { FplSeasonRef } from '../domain/fpl-season';

/**
 * Keep BullMQ construction out of the cache reader's module initialization.
 * API unit tests and cache-only consumers can load the service without needing
 * queue configuration; the queue is initialized only when a refresh is sent.
 */
export async function dispatchManagerLiveRefresh(input: {
  season: FplSeasonRef;
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
}): Promise<void> {
  const { enqueueManagerLiveRefresh } = await import('../jobs/manager-live.jobs');
  await enqueueManagerLiveRefresh(input);
}
