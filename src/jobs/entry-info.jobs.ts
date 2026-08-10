import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryInfoSyncJob } from './entry-sync-enqueue';
import { getEntryInfoSyncDateKey, hasEntryInfoSyncedToday } from './entry-info-sync-marker';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';

export function registerEntryInfoJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-info-daily',
      pattern: '30 10 * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('entry-info-daily', async () => {
            const now = new Date();
            const season = await seasonRepository.findCurrent();
            if (!(await isFPLSeason(season, now))) {
              logDebug('Skipping entry info sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }
            if (await hasEntryInfoSyncedToday(now)) {
              logInfo('Skipping entry info sync - already synced today', {
                date: getEntryInfoSyncDateKey(now),
              });
              return;
            }

            const dateKey = getEntryInfoSyncDateKey(now);
            const targetEventId = (await eventRepository.findLatestFinalized(season))?.id ?? 0;
            const job = await enqueueEntryInfoSyncJob(season, 'cron', {
              eventId: targetEventId,
              runId: `daily-${dateKey}`,
              jobId: `entry-info-daily-${dateKey}`,
              removeOnSettle: true,
            });
            logInfo('Entry info sync job enqueued via cron', {
              jobId: job.id,
              targetEventId,
            });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
