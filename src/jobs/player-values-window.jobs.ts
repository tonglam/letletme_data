import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { enqueuePlayerValuesSyncJob } from './data-sync-enqueue';
import { playerValuesRepository } from '../repositories/player-values';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';

function getChangeDateKey(date: Date) {
  return date.toISOString().split('T')[0].replace(/-/g, '');
}

async function shouldRunPlayerValuesSync(now: Date) {
  if (!(await isFPLSeason(now))) {
    logDebug('Skipping player values sync - not FPL season', { month: now.getMonth() + 1 });
    return false;
  }

  const changeDate = getChangeDateKey(now);
  const alreadySynced = await playerValuesRepository.hasChangesForDate(changeDate);
  if (alreadySynced) {
    logInfo('Skipping player values sync - price changes already recorded for today', {
      changeDate,
    });
    return false;
  }

  return true;
}

/**
 * Player Values Window Cron
 *
 * Polls FPL player prices every minute between 09:25 and 09:35 to
 * capture the once-per-day price update. Enqueues a BullMQ data-sync job
 * (retry/backoff) instead of running the sync inline so ticks cannot overlap.
 * The cron bails out immediately once today's price changes have been recorded.
 */
export function registerPlayerValuesWindowJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'player-values-sync',
      pattern: '25-35 9 * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('player-values-sync', async () => {
            const now = new Date();
            if (!(await shouldRunPlayerValuesSync(now))) {
              return;
            }

            const changeDate = getChangeDateKey(now);
            const job = await enqueuePlayerValuesSyncJob('cron', {
              // Stable id prevents stacking duplicate jobs during the 09:25-09:35 window.
              jobId: `player-values-${changeDate}`,
            });
            logInfo('Player values sync job enqueued via cron', { jobId: job.id });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
