import { cache } from '../cache/cache-operations';
import { logError } from '../utils/logger';

const ENTRY_INFO_SYNC_CACHE_PREFIX = 'entry-info-sync:daily';

export function getEntryInfoSyncDateKey(date: Date) {
  return date.toISOString().split('T')[0];
}

/**
 * Only mark the day synced after the final chunk completes with zero failures.
 * Mid-chunk success or pending failed-id retries must not suppress same-day re-enqueue.
 */
export function shouldMarkEntryInfoSynced(hasMore: boolean, failed: number): boolean {
  return !hasMore && failed === 0;
}

function getSecondsUntilNextDay(now: Date) {
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const diffSeconds = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
  return Math.max(diffSeconds, 60);
}

export async function hasEntryInfoSyncedToday(now: Date) {
  try {
    return await cache.exists(`${ENTRY_INFO_SYNC_CACHE_PREFIX}:${getEntryInfoSyncDateKey(now)}`);
  } catch (error) {
    logError('Failed to check entry info sync cache', error);
    return false;
  }
}

export async function markEntryInfoSyncedToday(now: Date, jobId?: string | number) {
  try {
    await cache.set(
      `${ENTRY_INFO_SYNC_CACHE_PREFIX}:${getEntryInfoSyncDateKey(now)}`,
      { ranAt: now.toISOString(), jobId },
      getSecondsUntilNextDay(now),
    );
  } catch (error) {
    logError('Failed to mark entry info sync run', error, { jobId });
  }
}
