import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { fplClient } from '../clients/fpl';
import { sendTelegramMessage } from '../utils/notify';
import { logError, logInfo } from '../utils/logger';

/**
 * Launch Monitor Jobs
 *
 * Polls bootstrap-static every minute year-round to detect season transitions:
 * - warning:   events list is empty → new season not yet published
 * - happening: events list present AND first event deadline is in the current year → season is live
 */

export async function runLaunchWarning() {
  try {
    const bootstrap = await fplClient.getBootstrap();
    if (bootstrap.events.length === 0) {
      const message = '【NEW SEASON】WARNING! WARNING! WARNING!';
      logInfo('Pre-season warning: FPL events list is empty');
      await sendTelegramMessage(message);
    }
  } catch (error) {
    logError('Launch warning check failed', error);
  }
}

export async function runLaunchHappening() {
  try {
    const bootstrap = await fplClient.getBootstrap();
    if (bootstrap.events.length === 0) return;

    const firstEvent = bootstrap.events[0];
    const currentYear = new Date().getFullYear().toString();

    if (firstEvent.deadline_time?.startsWith(currentYear)) {
      const message = '【NEW SEASON】ITS HAPPENING!!!';
      logInfo('New season detected: first event deadline is in current year', {
        deadlineTime: firstEvent.deadline_time,
        currentYear,
      });
      await sendTelegramMessage(message);
    }
  } catch (error) {
    logError('Launch happening check failed', error);
  }
}

export function registerLaunchJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'launch-warning',
        pattern: '* * * * *',
        async run() {
          await runLaunchWarning();
        },
      }),
    )
    .use(
      cron({
        name: 'launch-happening',
        pattern: '* * * * *',
        async run() {
          await runLaunchHappening();
        },
      }),
    );
}
