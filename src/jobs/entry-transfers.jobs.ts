import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryTransfersSyncJob } from './entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Transfers Cron Jobs
 *
 * Syncs transfers for all known entries in the current event.
 */
export function registerEntryTransfersJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-transfers-daily',
      pattern: '40 10 * * *',
      async run() {
        logInfo('Cron job started: entry-event-transfers-daily');
        try {
          const job = await enqueueEntryTransfersSyncJob('cron');
          logInfo('Entry transfers sync job enqueued via cron', { jobId: job.id });
        } catch (error) {
          logError('Cron job failed: entry-event-transfers-daily', error);
        }
      },
    }),
  );
}
