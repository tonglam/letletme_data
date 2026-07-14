import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { fixtureRepository } from '../repositories/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { enqueueLeagueEventResults } from './league-sync.jobs';
import type { LeagueSyncJobSource } from './league-sync.jobs';

/**
 * League Event Results Sync Trigger
 *
 * Strategy:
 * - Runs every 10 minutes during after-match-day window (aligned with live-events-db-sync)
 * - Enqueues coordinator job which fans out to per-tournament jobs
 * - Uses fresh event_lives data from DB for calculations
 */

export async function runLeagueEventResultsSync(options?: {
  skipMatchWindowCheck?: boolean;
  source?: LeagueSyncJobSource;
}) {
  const source = options?.source ?? 'cron';
  const skipMatchWindowCheck = options?.skipMatchWindowCheck ?? false;
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logDebug('Skipping league event results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping league event results sync - no current event');
    return;
  }

  const fixtures = await fixtureRepository.findByEvent(currentEvent.id);
  if (!skipMatchWindowCheck && !isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping league event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue coordinator job (will fan out to per-tournament jobs)
  const job = await enqueueLeagueEventResults(currentEvent.id, source);
  logInfo('League event results coordinator job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
    source,
    skipMatchWindowCheck,
  });
}

export function registerLeagueEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-results-trigger',
      pattern: '*/10 * * * *',
      async run() {
        try {
          await executeTrackedCron('league-event-results-sync', runLeagueEventResultsSync);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
