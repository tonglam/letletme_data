import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryPicksSyncJob } from './entry-sync-enqueue';
import { ENTRY_PICKS_CRON_PATTERN } from '../domain/job-schedules';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';

/**
 * Entry Event Picks Cron Jobs
 *
 * Syncs latest picks for all known entries in `entry_infos` for the current event.
 * Polls every five minutes so deadline-dependent publication windows are not
 * missed by a fixed wall-clock schedule.
 */
export function registerEntryPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-picks-window',
      pattern: ENTRY_PICKS_CRON_PATTERN,
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('entry-event-picks-window', async () => {
            const now = new Date();
            const season = await seasonRepository.findCurrent();
            if (!(await isFPLSeason(season, now))) {
              logDebug('Skipping entry picks sync - not FPL season', {
                month: now.getMonth() + 1,
              });
              return;
            }

            const currentEvent = await getCurrentEvent(season);
            if (!currentEvent) {
              logInfo('Skipping entry picks sync - no current event');
              return;
            }

            const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
            if (!isSelectTime(currentEvent, fixtures, now)) {
              logInfo('Skipping entry picks sync - outside pick window', {
                eventId: currentEvent.id,
              });
              return;
            }

            const job = await enqueueEntryPicksSyncJob(season, 'cron', {
              eventId: currentEvent.id,
            });
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
