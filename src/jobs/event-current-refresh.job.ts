import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { eventsCache } from '../cache/operations';
import { enqueueEventsSyncJob } from './data-sync-enqueue';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';

export async function runEventCurrentRefresh() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    return;
  }

  const deadlineDay = await eventsCache.isDeadlineDay();
  if (!deadlineDay) {
    logDebug('Skipping event:current refresh - not a deadline day');
    return;
  }

  const updated = await eventsCache.refreshCurrent();
  if (updated) {
    logInfo('Gameweek transition detected - triggering events sync');
    try {
      const job = await enqueueEventsSyncJob('event-transition');
      logInfo('Events sync job enqueued (transition)', { jobId: job.id });
    } catch {
      logInfo('Events sync job already enqueued or failed (transition)');
    }
  }
}

export function registerEventCurrentRefreshJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'event-current-refresh',
      pattern: '* * * * *',
      async run() {
        try {
          await executeTrackedCron('event-current-refresh', runEventCurrentRefresh);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
