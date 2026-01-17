import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { syncCurrentPlayerValues } from '../services/player-values.service';
import { playerValuesRepository } from '../repositories/player-values';
import { isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

function getChangeDateKey(date: Date) {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

async function shouldRunPlayerValuesSync(now: Date) {
  if (!isFPLSeason(now)) {
    logInfo('Skipping player values sync - not FPL season', { month: now.getMonth() + 1 });
    return false;
  }

  const changeDate = getChangeDateKey(now);
  const alreadySynced = await playerValuesRepository.hasChangesForDate(changeDate);
  if (alreadySynced) {
    logInfo('Skipping player values sync - already synced today', { changeDate });
    return false;
  }

  return true;
}

/**
 * Player Values Window Cron
 *
 * Polls FPL player prices every minute between 09:25 and 09:35 to
 * capture the once-per-day price update. The cron bails out immediately
 * once today's price changes have been recorded to avoid hammering FPL.
 */
export function registerPlayerValuesWindowJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'player-values-sync',
      pattern: '25-35 9 * * *',
      async run() {
        logInfo('Cron job started: player-values-sync');
        const now = new Date();
        if (!(await shouldRunPlayerValuesSync(now))) {
          return;
        }

        try {
          await syncCurrentPlayerValues();
          logInfo('Cron job completed: player-values-sync');
        } catch (error) {
          logError('Cron job failed: player-values-sync', error);
        }
      },
    }),
  );
}
