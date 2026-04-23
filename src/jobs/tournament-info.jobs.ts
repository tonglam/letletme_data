import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { syncTournamentInfo } from '../services/tournament-info.service';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';

export async function runTournamentInfoSync() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logInfo('Skipping tournament info sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  logInfo('Tournament info sync started');
  const result = await syncTournamentInfo();
  logInfo('Tournament info sync completed', result);
}

export function registerTournamentInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-info-sync',
      pattern: '45 10 * * *',
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
