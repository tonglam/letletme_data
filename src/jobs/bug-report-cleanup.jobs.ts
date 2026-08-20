import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { runBugReportCleanup } from '../services/bug-report-cleanup.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logError } from '../utils/logger';
import { BUG_REPORT_CLEANUP_TIMEZONE } from '../utils/timezone';

export const BUG_REPORT_CLEANUP_CRON_PATTERN = '15 3 * * *';

export function registerBugReportCleanupJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'bug-report-cleanup',
      pattern: BUG_REPORT_CLEANUP_CRON_PATTERN,
      timezone: BUG_REPORT_CLEANUP_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('bug-report-cleanup', async () => {
            await runBugReportCleanup();
          });
        } catch (error) {
          logError('Bug report cleanup failed; rows remain for retry', error);
        }
      },
    }),
  );
}
