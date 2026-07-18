import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { enqueueTournamentInfo } from './tournament-sync.jobs';

export async function runTournamentInfoSync() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logDebug('Skipping tournament info sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  logInfo('Enqueueing tournament info sync job');
  const job = await enqueueTournamentInfo(0, 'cron');
  logInfo('Tournament info sync job enqueued', { jobId: job.id });
}

export function registerTournamentInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-info-sync',
      pattern: '45 10 * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('tournament-info-sync', runTournamentInfoSync);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
