import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryResultsSyncJob } from './entry-sync-enqueue';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';

/**
 * Entry Event Results Cron Jobs
 *
 * Syncs per-GW results (points, ranks, captain, etc.) for current event.
 */
export function registerEntryResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-results-daily',
      pattern: '45 10 * * *',
      async run() {
        try {
          await executeTrackedCron('entry-event-results-daily', async () => {
            const now = new Date();
            if (!(await isFPLSeason(now))) {
              logDebug('Skipping entry results sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }

            const currentEvent = await getCurrentEvent();
            if (!currentEvent) {
              logInfo('Skipping entry results sync - no current event');
              return;
            }

            const job = await enqueueEntryResultsSyncJob('cron', {
              eventId: currentEvent.id,
            });
            logInfo('Entry results sync job enqueued via cron', {
              jobId: job.id,
              eventId: currentEvent.id,
            });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
