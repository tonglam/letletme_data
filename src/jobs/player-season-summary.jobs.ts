import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { repairPlayerSeasonSummaries } from '../services/player-season-summaries.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { CRON_TIMEZONE } from '../utils/timezone';

export const PLAYER_SEASON_SUMMARY_REPAIR_SCHEDULE = '17 * * * *';

export function registerPlayerSeasonSummaryJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'player-season-summary-repair',
      pattern: PLAYER_SEASON_SUMMARY_REPAIR_SCHEDULE,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('player-season-summary-repair', async () => {
            await repairPlayerSeasonSummaries();
          });
        } catch {
          // executeTrackedCron already records and logs the failure.
        }
      },
    }),
  );
}
