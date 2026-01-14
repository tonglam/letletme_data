import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryInfoSyncJob } from './entry-sync.queue';
import { logError, logInfo } from '../utils/logger';

export function registerEntryInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-info-daily',
      pattern: '30 10 * * *',
      async run() {
        logInfo('Cron job started: entry-info-daily');
        try {
          const job = await enqueueEntryInfoSyncJob('cron');
          logInfo('Entry info sync job enqueued via cron', { jobId: job.id });
        } catch (error) {
          logError('Cron job failed: entry-info-daily', error);
        }
      },
    }),
  );
}
