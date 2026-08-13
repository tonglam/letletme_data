import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN } from '../domain/job-schedules';
import { checkPlayerMarketFreshness } from '../services/player-market-freshness.service';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logError } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { CRON_TIMEZONE } from '../utils/timezone';

export async function runPlayerMarketFreshnessWatchdog(now: Date = new Date()) {
  try {
    return await checkPlayerMarketFreshness(now);
  } catch (error) {
    logError('Player market freshness watchdog failed', error);
    await notifyTwoBots(
      '[player-market-freshness] check failed before a complete snapshot could be verified',
    );
    throw error;
  }
}

export function registerPlayerMarketFreshnessJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'player-market-freshness-watchdog',
      pattern: PLAYER_MARKET_FRESHNESS_WATCHDOG_CRON_PATTERN,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('player-market-freshness-watchdog', async () => {
            await runPlayerMarketFreshnessWatchdog();
          });
        } catch {
          // The tracked run and notification channel already carry the evidence.
        }
      },
    }),
  );
}
