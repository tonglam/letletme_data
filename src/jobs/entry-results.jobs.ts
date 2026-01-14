import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryResultsSyncJob } from './entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

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
        logInfo('Cron job started: entry-event-results-daily');
        try {
          const job = await enqueueEntryResultsSyncJob('cron');
          logInfo('Entry results sync job enqueued via cron', { jobId: job.id });
        } catch (error) {
          logError('Cron job failed: entry-event-results-daily', error);
        }
      },
    }),
  );
}
