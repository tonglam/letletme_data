import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryPicksSyncJob } from './entry-sync-enqueue';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';

/**
 * Entry Event Picks Cron Jobs
 *
 * Syncs latest picks for all known entries in `entry_infos` for the current event.
 * Scheduled daily after core data syncs.
 */
export function registerEntryPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-picks-daily',
      pattern: '35 10 * * *',
      async run() {
        try {
          await executeTrackedCron('entry-event-picks-daily', async () => {
            const now = new Date();
            if (!isFPLSeason(now)) {
              logInfo('Skipping entry picks sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }

            const currentEvent = await getCurrentEvent();
            if (!currentEvent) {
              logInfo('Skipping entry picks sync - no current event');
              return;
            }

            const fixtures = await loadFixturesByEvent(currentEvent.id);
            if (!isSelectTime(currentEvent, fixtures, now)) {
              logInfo('Skipping entry picks sync - outside pick window', {
                eventId: currentEvent.id,
              });
              return;
            }

            const job = await enqueueEntryPicksSyncJob('cron', { eventId: currentEvent.id });
            logInfo('Entry picks sync job enqueued via cron', {
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
