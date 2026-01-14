import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryPicksSyncJob } from './entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Picks Cron Jobs
 *
 * Syncs latest picks for all known entries in `entry_infos` for the current event.
 * Scheduled daily after core data syncs.
 */
export function registerEntryPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-picks-daily',
      pattern: '35 10 * * *',
      async run() {
        logInfo('Cron job started: entry-event-picks-daily');
        try {
          const job = await enqueueEntryPicksSyncJob('cron');
          logInfo('Entry picks sync job enqueued via cron', { jobId: job.id });
        } catch (error) {
          logError('Cron job failed: entry-event-picks-daily', error);
        }
      },
    }),
  );
}
