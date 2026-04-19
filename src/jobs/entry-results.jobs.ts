import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryResultsSyncJob } from './entry-sync-enqueue';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';

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
            const job = await enqueueEntryResultsSyncJob('cron');
            logInfo('Entry results sync job enqueued via cron', { jobId: job.id });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
