import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { purgeClientSignalRetention } from '../services/client-signals.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const CLIENT_SIGNAL_RETENTION_SCHEDULE = '30 3 * * *';

export function registerClientSignalRetentionJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'client-signal-retention',
      pattern: CLIENT_SIGNAL_RETENTION_SCHEDULE,
      timezone: CRON_TIMEZONE,
      async run() {
        await executeTrackedCron('client-signal-retention', async () => {
          if (isStandaloneSchedulerEnabled()) return;
          await purgeClientSignalRetention();
        });
      },
    }),
  );
}
