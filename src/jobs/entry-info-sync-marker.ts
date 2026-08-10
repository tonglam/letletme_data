import { queueRedisSingleton } from '../queues/redis';
import { logError } from '../utils/logger';

const ENTRY_INFO_SYNC_MARKER_PREFIX = 'llm:queue:coordination:entry-info-sync:daily';

export function getEntryInfoSyncDateKey(date: Date) {
  return date.toISOString().split('T')[0];
}

/**
 * Only mark the day synced after the final database-scan chunk completes with
 * zero failures. Targeted API work, mid-chunk success, and failed-id retries
 * must not suppress the scheduled full scan.
 */
export function shouldMarkEntryInfoSynced(
  fetchedFromDb: boolean,
  hasMore: boolean,
  failed: number,
): boolean {
  return fetchedFromDb && !hasMore && failed === 0;
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
    const redis = await queueRedisSingleton.getClient();
    return (
      (await redis.exists(`${ENTRY_INFO_SYNC_MARKER_PREFIX}:${getEntryInfoSyncDateKey(now)}`)) === 1
    );
  } catch (error) {
    logError('Failed to check entry info sync cache', error);
    return false;
  }
}

export async function markEntryInfoSyncedToday(now: Date, jobId?: string | number) {
  try {
    const redis = await queueRedisSingleton.getClient();
    await redis.set(
      `${ENTRY_INFO_SYNC_MARKER_PREFIX}:${getEntryInfoSyncDateKey(now)}`,
      JSON.stringify({ ranAt: now.toISOString(), jobId }),
      'EX',
      getSecondsUntilNextDay(now),
    );
  } catch (error) {
    logError('Failed to mark entry info sync run', error, { jobId });
  }
}
