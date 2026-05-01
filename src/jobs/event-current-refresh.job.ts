import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { eventsCache } from '../cache/operations';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueEventsSyncJob } from './data-sync-enqueue';

export type ManualEventCurrentRefreshResult = {
  refreshed: boolean;
  eventsSyncJobId?: string;
};

/**
 * HTTP / ops trigger: recomputes `event:current` from the `Event:{season}` hash immediately.
 * Does not check isFPLSeason (cron still does). If the derived gameweek id changes, enqueues
 * `events-sync` like the automatic path.
 */
export async function runManualEventCurrentRefresh(): Promise<ManualEventCurrentRefreshResult> {
  const updated = await eventsCache.refreshCurrent();
  if (!updated) {
    return { refreshed: false };
  }

  logInfo('Manual event-current-refresh: gameweek id changed, enqueuing events sync');
  try {
    const job = await enqueueEventsSyncJob('manual');
    logInfo('Events sync job enqueued (manual after event:current refresh)', { jobId: job.id });
    return { refreshed: true, eventsSyncJobId: job.id };
  } catch {
    logInfo('Events sync job already enqueued or failed (manual after event:current refresh)');
    return { refreshed: true };
  }
}

export async function runEventCurrentRefresh() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    return;
  }

  // Derive current GW from Event:{season} via deadlines every tick. A former isDeadlineDay()
  // gate compared local calendar dates to the next GW and could skip real transitions.
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
