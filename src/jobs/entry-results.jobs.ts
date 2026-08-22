import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { enqueueMyFplSnapshot } from './maintenance.jobs';
import { executeTrackedCron } from '../utils/job-run-logger';
import { isFPLSeason } from '../utils/conditions';
import { getCurrentEvent } from '../services/events.service';
import { seasonRepository } from '../repositories/seasons';
import { logInfo } from '../utils/logger';
import { CRON_TIMEZONE, formatCronDateKey } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

/**
 * Entry Event Results Cron Jobs
 *
 * Syncs per-GW results (points, ranks, captain, etc.) for current event.
 */
export function registerEntryResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-results-daily',
      pattern: '45 10 * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('entry-event-results-daily', async () => {
            if (isStandaloneSchedulerEnabled()) return;
            const season = await seasonRepository.findCurrent();
            if (!(await isFPLSeason(season))) {
              logInfo('Skipping entry results sync - outside FPL season');
              return;
            }
            const currentEvent = await getCurrentEvent(season);
            if (!currentEvent) {
              logInfo('Skipping entry results sync - no current event');
              return;
            }
            const job = await enqueueMyFplSnapshot(season, 'cron', {
              eventId: currentEvent.id,
              snapshotKind: 'PROVISIONAL',
              jobId: `compat-entry-event-results-daily-${formatCronDateKey()}`,
            });
            logInfo('My FPL snapshot coordinator enqueued via compatibility cron', {
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
