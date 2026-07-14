import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { deriveSeasonFromEvents } from '../cache/cache-season';
import { redisSingleton } from '../cache/singleton';
import { fplClient } from '../clients/fpl';
import { executeTrackedCron } from '../utils/job-run-logger';
import { sendTelegramMessage } from '../utils/notify';
import { logInfo } from '../utils/logger';

/**
 * Launch Monitor Jobs
 *
 * Polls bootstrap-static every minute year-round to detect season transitions:
 * - warning:   events list is empty → new season not yet published
 * - happening: events list present AND first event deadline is in the current year → season is live
 */

async function shouldSendLaunchNotification(key: string): Promise<boolean> {
  const redis = await redisSingleton.getClient();
  const result = await redis.set(key, new Date().toISOString(), 'NX');
  return result === 'OK';
}

export async function runLaunchWarning() {
  const bootstrap = await fplClient.getBootstrap();
  if (bootstrap.events.length === 0) {
    // Year-suffixed so the warning can re-arm each pre-season (season string is
    // unknowable while the events list is still empty).
    const year = new Date().getFullYear();
    const shouldSend = await shouldSendLaunchNotification(`LaunchNotification:warning:${year}`);
    if (!shouldSend) {
      return;
    }

    const message = '【NEW SEASON】WARNING! WARNING! WARNING!';
    logInfo('Pre-season warning: FPL events list is empty');
    await sendTelegramMessage(message);
  }
}

export async function runLaunchHappening() {
  const bootstrap = await fplClient.getBootstrap();
  if (bootstrap.events.length === 0) return;

  const firstEvent = bootstrap.events[0];
  const publishedSeason = deriveSeasonFromEvents(bootstrap.events);
  const currentYear = new Date().getFullYear().toString();

  if (publishedSeason && firstEvent.deadline_time?.startsWith(currentYear)) {
    const shouldSend = await shouldSendLaunchNotification(
      `LaunchNotification:happening:${publishedSeason}`,
    );
    if (!shouldSend) {
      return;
    }

    const message = '【NEW SEASON】ITS HAPPENING!!!';
    logInfo('New season detected: first event deadline is published', {
      deadlineTime: firstEvent.deadline_time,
      publishedSeason,
    });
    await sendTelegramMessage(message);
  }
}

export function registerLaunchJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'launch-warning',
        pattern: '* * * * *',
        async run() {
          try {
            await executeTrackedCron('launch-warning', runLaunchWarning);
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'launch-happening',
        pattern: '* * * * *',
        async run() {
          try {
            await executeTrackedCron('launch-happening', runLaunchHappening);
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    );
}
