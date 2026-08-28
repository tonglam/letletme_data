import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { enqueuePlayerValuesSyncJob } from './data-sync-enqueue';
import {
  PLAYER_VALUES_CRON_PATTERN,
  PLAYER_VALUES_CRON_ROLLOVER_PATTERN,
} from '../domain/job-schedules';
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

export type PlayerValuesSyncDecision = Readonly<{
  shouldRun: boolean;
  pollUntilWindowEnd: boolean;
}>;

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

export async function resolvePlayerValuesSyncDecision(
  now: Date,
  dependencies: PlayerValuesWindowDependencies = defaultDependencies,
): Promise<PlayerValuesSyncDecision> {
  const syncEvent = await dependencies.resolvePlayerSyncEvent(now);
  if (!syncEvent) {
    return { shouldRun: false, pollUntilWindowEnd: false };
  }

  // The cron covers the full in-season polling window. Before GW1, only its
  // first tick is allowed through so an unchanged bootstrap is checked once.
  if (syncEvent.phase === 'preseason' && getCronMinute(now) !== 55) {
    return { shouldRun: false, pollUntilWindowEnd: false };
  }

  const changeDate = formatCronDateKey(now);
  const alreadySynced = await dependencies.hasChangesForDate(changeDate);
  if (alreadySynced) {
    logInfo('Skipping player values sync - price changes already recorded for today', {
      changeDate,
    });
    return { shouldRun: false, pollUntilWindowEnd: false };
  }

  return { shouldRun: true, pollUntilWindowEnd: syncEvent.phase === 'current' };
}

export async function shouldRunPlayerValuesSync(
  now: Date,
  dependencies: PlayerValuesWindowDependencies = defaultDependencies,
) {
  return (await resolvePlayerValuesSyncDecision(now, dependencies)).shouldRun;
}

/**
 * Player Values Window Cron
 *
 * Before GW1 only the 06:55 tick runs. Once an event is current, prices are
 * polled every minute between 06:55 and 07:05 until the daily change is stored.
 */
async function runPlayerValuesSync() {
  try {
    await executeTrackedCron('player-values-sync', async () => {
      if (isStandaloneSchedulerEnabled()) return;
      const now = new Date();
      const decision = await resolvePlayerValuesSyncDecision(now);
      if (!decision.shouldRun) {
        return;
      }

      const changeDate = formatCronDateKey(now);
      const season = await seasonRepository.findCurrent();
      const job = await enqueuePlayerValuesSyncJob(season, 'cron', {
        // One stable ID owns the whole polling window; no-change results are
        // retried by BullMQ so later upstream price updates are still observed.
        jobId: `player-values-${changeDate}`,
        changeDate,
        pollUntilWindowEnd: decision.pollUntilWindowEnd,
      });
      logInfo('Player values sync job enqueued via cron', { jobId: job.id });
    });
  } catch {
    // Failure details are already emitted by runTrackedJob.
  }
}

export function registerPlayerValuesWindowJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'player-values-sync',
        pattern: PLAYER_VALUES_CRON_PATTERN,
        timezone: CRON_TIMEZONE,
        run: runPlayerValuesSync,
      }),
    )
    .use(
      cron({
        name: 'player-values-sync-rollover',
        pattern: PLAYER_VALUES_CRON_ROLLOVER_PATTERN,
        timezone: CRON_TIMEZONE,
        run: runPlayerValuesSync,
      }),
    );
}
