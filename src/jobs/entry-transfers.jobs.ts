import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueEntryTransfersSyncJob } from './entry-sync.queue';
import { getCurrentEvent } from '../services/events.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Transfers Cron Jobs
 *
 * Syncs transfers for all known entries in the current event.
 */
export function registerEntryTransfersJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-transfers-daily',
      pattern: '40 10 * * *',
      async run() {
        logInfo('Cron job started: entry-event-transfers-daily');
        const now = new Date();
        if (!isFPLSeason(now)) {
          logInfo('Skipping entry transfers sync - not FPL season', {
            month: now.getMonth() + 1,
          });
          return;
        }

        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          logInfo('Skipping entry transfers sync - no current event');
          return;
        }

        const fixtures = await loadFixturesByEvent(currentEvent.id);
        if (!isAfterMatchDay(currentEvent, fixtures, now)) {
          logInfo('Skipping entry transfers sync - before matchday end', {
            eventId: currentEvent.id,
          });
          return;
        }

        try {
          const job = await enqueueEntryTransfersSyncJob('cron', { eventId: currentEvent.id });
          logInfo('Entry transfers sync job enqueued via cron', {
            jobId: job.id,
            eventId: currentEvent.id,
          });
        } catch (error) {
          logError('Cron job failed: entry-event-transfers-daily', error);
        }
      },
    }),
  );
}
