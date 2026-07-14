import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryInfoSyncJob } from './entry-sync-enqueue';
import { getEntryInfoSyncDateKey, hasEntryInfoSyncedToday } from './entry-info-sync-marker';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';

export function registerEntryInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-info-daily',
      pattern: '30 10 * * *',
      async run() {
        try {
          await executeTrackedCron('entry-info-daily', async () => {
            const now = new Date();
            if (!(await isFPLSeason(now))) {
              logDebug('Skipping entry info sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }
            if (await hasEntryInfoSyncedToday(now)) {
              logInfo('Skipping entry info sync - already synced today', {
                date: getEntryInfoSyncDateKey(now),
              });
              return;
            }

            const job = await enqueueEntryInfoSyncJob('cron');
            logInfo('Entry info sync job enqueued via cron', { jobId: job.id });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
