import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { enqueuePlayerValuesSyncJob } from './data-sync-enqueue';
import { PLAYER_VALUES_CRON_PATTERN } from '../domain/job-schedules';
import { playerValuesRepository } from '../repositories/player-values';
import { seasonRepository } from '../repositories/seasons';
import {
  resolvePlayerSyncEvent,
  type PlayerSyncEvent,
} from '../services/player-sync-event.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { CRON_TIMEZONE, formatCronDateKey, getCronMinute } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export type PlayerValuesWindowDependencies = {
  resolvePlayerSyncEvent: (date: Date) => Promise<PlayerSyncEvent | null>;
  hasChangesForDate: (changeDate: string) => Promise<boolean>;
};

const defaultDependencies: PlayerValuesWindowDependencies = {
  resolvePlayerSyncEvent: async (date) => {
    const season = await seasonRepository.findCurrent();
    return resolvePlayerSyncEvent(season, date);
  },
  hasChangesForDate: async (changeDate) => {
    const season = await seasonRepository.findCurrent();
    return playerValuesRepository.hasChangesForDate(season, changeDate);
  },
};

export async function shouldRunPlayerValuesSync(
  now: Date,
  dependencies: PlayerValuesWindowDependencies = defaultDependencies,
) {
  const syncEvent = await dependencies.resolvePlayerSyncEvent(now);
  if (!syncEvent) {
    return false;
  }

  // The cron covers the full in-season polling window. Before GW1, only its
  // first tick is allowed through so an unchanged bootstrap is checked once.
  if (syncEvent.phase === 'preseason' && getCronMinute(now) !== 25) {
    return false;
  }

  const changeDate = formatCronDateKey(now);
  const alreadySynced = await dependencies.hasChangesForDate(changeDate);
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
 * Before GW1 only the 09:25 tick runs. Once an event is current, prices are
 * polled every minute between 09:25 and 09:35 until the daily change is stored.
 */
export function registerPlayerValuesWindowJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'player-values-sync',
      pattern: PLAYER_VALUES_CRON_PATTERN,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('player-values-sync', async () => {
            if (isStandaloneSchedulerEnabled()) return;
            const now = new Date();
            if (!(await shouldRunPlayerValuesSync(now))) {
              return;
            }

            const changeDate = formatCronDateKey(now);
            const season = await seasonRepository.findCurrent();
            const job = await enqueuePlayerValuesSyncJob(season, 'cron', {
              // Stable id prevents stacking duplicate jobs during the 09:25-09:35 window.
              jobId: `player-values-${changeDate}`,
              changeDate,
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
