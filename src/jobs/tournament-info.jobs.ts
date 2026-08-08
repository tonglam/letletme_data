import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { seasonRepository } from '../repositories/seasons';
import { enqueueTournamentInfo, enqueueTournamentRosterSync } from './tournament-sync.jobs';

export async function runTournamentInfoSync() {
  const now = new Date();
  const season = await seasonRepository.findCurrent();
  if (!(await isFPLSeason(season, now))) {
    logDebug('Skipping tournament info sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  logInfo('Enqueueing tournament info sync job');
  const [rosterJob, infoJob] = await Promise.all([
    enqueueTournamentRosterSync(season, 'cron'),
    enqueueTournamentInfo(season, 0, 'cron'),
  ]);
  logInfo('Tournament metadata jobs enqueued', {
    rosterJobId: rosterJob.id,
    infoJobId: infoJob.id,
  });
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
