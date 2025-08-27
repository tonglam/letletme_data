import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { getCurrentGameweek, isFPLSeason, isMatchHours, isWeekend } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

/**
 * Live Data Cron Jobs
 *
 * Handles real-time and periodic data updates:
 * - Live scores (every 15 minutes during match hours)
 * - Weekly rankings (Sunday at 10 PM)
 *
 * These jobs are conditional and only run when appropriate.
 */

async function runLiveScores() {
  const now = new Date();
  const shouldRun = isWeekend(now) && isFPLSeason(now) && isMatchHours(now);

  if (!shouldRun) {
    logInfo('Skipping live scores - conditions not met', {
      isWeekend: isWeekend(now),
      isFPLSeason: isFPLSeason(now),
      isMatchHours: isMatchHours(now),
    });
    return;
  }

  logInfo('Live scores sync started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement live scores logic
  logInfo('Live scores sync completed (placeholder)');
}

async function runWeeklyRankings() {
  const now = new Date();

  if (!isFPLSeason(now)) {
    logInfo('Skipping weekly rankings - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  logInfo('Weekly rankings started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement weekly rankings logic
  logInfo('Weekly rankings completed (placeholder)');
}

export function registerLiveJobs(app: Elysia) {
  return (
    app
      // Live scores - Every 15 minutes (simplified for now)
      .use(
        cron({
          name: 'live-scores',
          pattern: '*/15 * * * *', // Every 15 minutes
          async run() {
            logInfo('Cron job started: live-scores');
            try {
              await runLiveScores();
              logInfo('Cron job completed: live-scores');
            } catch (error) {
              logError('Cron job failed: live-scores', error);
            }
          },
        }),
      )

      // Weekly rankings - Sunday at 10 PM
      .use(
        cron({
          name: 'weekly-rankings',
          pattern: '0 22 * * 0',
          async run() {
            logInfo('Cron job started: weekly-rankings');
            try {
              await runWeeklyRankings();
              logInfo('Cron job completed: weekly-rankings');
            } catch (error) {
              logError('Cron job failed: weekly-rankings', error);
            }
          },
        }),
      )
  );
}
