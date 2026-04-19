import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryInfoSyncJob } from './entry-sync-enqueue';
import { cache } from '../cache/cache-operations';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';

const ENTRY_INFO_SYNC_CACHE_PREFIX = 'entry-info-sync:daily';

function getDateKey(date: Date) {
  return date.toISOString().split('T')[0];
}

function getSecondsUntilNextDay(now: Date) {
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const diffSeconds = Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
  return Math.max(diffSeconds, 60);
}

async function hasSyncedToday(now: Date) {
  try {
    return await cache.exists(`${ENTRY_INFO_SYNC_CACHE_PREFIX}:${getDateKey(now)}`);
  } catch (error) {
    logError('Failed to check entry info sync cache', error);
    return false;
  }
}

async function markSyncedToday(now: Date, jobId?: string | number) {
  try {
    await cache.set(
      `${ENTRY_INFO_SYNC_CACHE_PREFIX}:${getDateKey(now)}`,
      { ranAt: now.toISOString(), jobId },
      getSecondsUntilNextDay(now),
    );
  } catch (error) {
    logError('Failed to mark entry info sync run', error, { jobId });
  }
}

export function registerEntryInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-info-daily',
      pattern: '30 10 * * *',
      async run() {
        try {
          await executeTrackedCron('entry-info-daily', async () => {
            const now = new Date();
            if (!isFPLSeason(now)) {
              logInfo('Skipping entry info sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }
            if (await hasSyncedToday(now)) {
              logInfo('Skipping entry info sync - already synced today', {
                date: getDateKey(now),
              });
              return;
            }

            const job = await enqueueEntryInfoSyncJob('cron');
            logInfo('Entry info sync job enqueued via cron', { jobId: job.id });
            await markSyncedToday(now, job.id);
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
