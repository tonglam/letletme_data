import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueCoreSnapshotJob } from './data-sync-enqueue';
import { CRON_TIMEZONE } from '../utils/timezone';

export type ManualEventCurrentRefreshResult = {
  refreshed: boolean;
  eventsSyncJobId?: string;
};

/**
 * HTTP / ops trigger: compares the database-derived current event with the active
 * immutable core publication. A mismatch enqueues a complete core rebuild.
 */
export async function runManualEventCurrentRefresh(): Promise<ManualEventCurrentRefreshResult> {
  const season = await seasonRepository.findCurrent();
  const [current, publication] = await Promise.all([
    eventRepository.findCurrent(season),
    readCoreSnapshotCache(season.seasonCode),
  ]);
  if (publication?.currentEventId === (current?.id ?? null)) {
    return { refreshed: false };
  }

  logInfo('Manual event-current-refresh: gameweek id changed, enqueuing core snapshot');
  try {
    const job = await enqueueCoreSnapshotJob(season, 'manual');
    logInfo('Core snapshot job enqueued after current-event publication check', { jobId: job.id });
    return { refreshed: true, eventsSyncJobId: job.id };
  } catch {
    logInfo('Core snapshot job already enqueued or failed after current-event publication check');
    return { refreshed: true };
  }
}

export async function runEventCurrentRefresh() {
  const now = new Date();
  const season = await seasonRepository.findCurrent();
  if (!(await isFPLSeason(season, now))) {
    return;
  }

  const [current, publication] = await Promise.all([
    eventRepository.findCurrent(season),
    readCoreSnapshotCache(season.seasonCode),
  ]);
  if (publication?.currentEventId !== (current?.id ?? null)) {
    logInfo('Gameweek transition detected - triggering core snapshot');
    try {
      const job = await enqueueCoreSnapshotJob(season, 'event-transition');
      logInfo('Core snapshot job enqueued (transition)', { jobId: job.id });
    } catch {
      logInfo('Core snapshot job already enqueued or failed (transition)');
    }
  }
}

export function registerEventCurrentRefreshJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'event-current-refresh',
      pattern: '* * * * *',
      timezone: CRON_TIMEZONE,
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
