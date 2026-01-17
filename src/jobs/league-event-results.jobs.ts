import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';
import { enqueueLeagueEventResults } from './league-sync.jobs';

/**
 * League Event Results Sync Trigger
 *
 * Strategy:
 * - Runs every 10 minutes during after-match-day window (aligned with live-events-db-sync)
 * - Enqueues coordinator job which fans out to per-tournament jobs
 * - Uses fresh event_lives data from DB for calculations
 */

export async function runLeagueEventResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping league event results sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping league event results sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping league event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue coordinator job (will fan out to per-tournament jobs)
  const job = await enqueueLeagueEventResults(currentEvent.id, 'cron');
  logInfo('League event results coordinator job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

export function registerLeagueEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-results-trigger',
      pattern: '*/10 * * * *',
      async run() {
        logInfo('Cron trigger: league-event-results-sync');
        try {
          await runLeagueEventResultsSync();
        } catch (error) {
          logError('Cron trigger failed: league-event-results-sync', error);
        }
      },
    }),
  );
}
