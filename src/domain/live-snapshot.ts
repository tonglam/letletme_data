export type LiveSnapshotState = 'scheduled' | 'live' | 'settled';

export function shouldSkipQueuedLiveSnapshot(
  source: 'cron' | 'manual' | 'cascade',
  persistEventLives: boolean,
  windowOpen: boolean,
): boolean {
  return source === 'cron' && !persistEventLives && !windowOpen;
}

/**
 * Downstream DB derivatives follow the durable checkpoint, not the Redis
 * publication result. A newer cache-only worker can win Redis metadata after
 * this worker commits event_live rows; that must not suppress the cascade.
 */
export function shouldCascadePersistedLiveSnapshot(snapshot: {
  stale: boolean;
  persistedEventLives: boolean;
}): boolean {
  return snapshot.persistedEventLives;
}
