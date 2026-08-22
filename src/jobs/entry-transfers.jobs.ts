import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryTransfersSyncJob } from './entry-sync-enqueue';
import { ENTRY_PICKS_CRON_PATTERN } from '../domain/job-schedules';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';

/**
 * Entry Event Transfers Cron Jobs
 *
 * Syncs transfers for all known entries in the current event during the same
 * post-deadline publication window as entry picks.
 */
export function registerEntryTransfersJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-transfers-daily',
      pattern: ENTRY_PICKS_CRON_PATTERN,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('entry-event-transfers-daily', async () => {
            const now = new Date();
            const season = await seasonRepository.findCurrent();
            if (!(await isFPLSeason(season, now))) {
              logDebug('Skipping entry transfers sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }

            const currentEvent = await getCurrentEvent(season);
            if (!currentEvent) {
              logInfo('Skipping entry transfers sync - no current event');
              return;
            }

            const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
            if (!isSelectTime(currentEvent, fixtures, now)) {
              logInfo('Skipping entry transfers sync - outside entry snapshot window', {
                eventId: currentEvent.id,
              });
              return;
            }

            const job = await enqueueEntryTransfersSyncJob(season, 'cron', {
              eventId: currentEvent.id,
            });
            logInfo('Entry transfers sync job enqueued via cron', {
              jobId: job.id,
              eventId: currentEvent.id,
            });
          });
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
