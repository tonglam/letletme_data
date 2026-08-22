import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { runBugReportScreenshotRetention } from '../services/bug-report-screenshot-retention.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const BUG_REPORT_SCREENSHOT_RETENTION_SCHEDULE = '20 3 * * *';

export function registerBugReportScreenshotRetentionJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'bug-report-screenshot-retention',
      pattern: BUG_REPORT_SCREENSHOT_RETENTION_SCHEDULE,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('bug-report-screenshot-retention', async () => {
            if (isStandaloneSchedulerEnabled()) return;
            await runBugReportScreenshotRetention();
          });
        } catch {
          // executeTrackedCron records the failure; the next day retries it.
        }
      },
    }),
  );
}
