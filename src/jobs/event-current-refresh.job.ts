import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { coreSnapshotRefreshReason } from '../domain/core-snapshot-refresh';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueCoreSnapshotJob, enqueuePlayerStatsSyncJob } from './data-sync-enqueue';
import { CRON_TIMEZONE } from '../utils/timezone';

export type ManualEventCurrentRefreshResult = {
  refreshed: boolean;
  eventsSyncJobId?: string;
};

async function readCurrentLifecycle() {
  const season = await seasonRepository.findCurrent();
  const current = await eventRepository.findCurrent(season);
  const [currentFixtures, publication] = await Promise.all([
    current ? fixtureRepository.findByEvent(season, current.id) : Promise.resolve([]),
    readCoreSnapshotCache(season.seasonCode),
  ]);
  return { season, current, currentFixtures, publication };
}

/**
 * HTTP / ops trigger: compares the database-derived current event with the active
 * immutable core publication. A mismatch enqueues a complete core rebuild.
 */
export async function runManualEventCurrentRefresh(): Promise<ManualEventCurrentRefreshResult> {
  const { season, current, currentFixtures, publication } = await readCurrentLifecycle();
  const reason = coreSnapshotRefreshReason(current, currentFixtures, publication);
  if (!reason) {
    return { refreshed: false };
  }

  logInfo('Manual event-current-refresh: stale core lifecycle detected', { reason });
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
  const { season, current, currentFixtures, publication } = await readCurrentLifecycle();
  if (!(await isFPLSeason(season, now))) {
    return;
  }

  const reason = coreSnapshotRefreshReason(current, currentFixtures, publication, now);
  if (reason) {
    logInfo('Gameweek lifecycle transition detected - triggering core snapshot', { reason });
    try {
      const job = await enqueueCoreSnapshotJob(season, 'event-transition');
      logInfo('Core snapshot job enqueued (transition)', { jobId: job.id });
      if (current) {
        const playerStatsJob = await enqueuePlayerStatsSyncJob(season, 'event-transition', {
          eventId: current.id,
          jobId: `player-stats-transition-e${current.id}`,
          removeOnSettle: true,
        });
        logInfo('Player stats job enqueued (transition)', { jobId: playerStatsJob.id });
      }
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
