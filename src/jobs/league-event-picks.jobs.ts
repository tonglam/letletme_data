import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';
import { enqueueLeagueEventPicks } from './league-sync.jobs';

/**
 * League Event Picks Sync Trigger
 *
 * Strategy:
 * - Cron checks conditions (FPL season, current event, select time)
 * - Enqueues coordinator job which fans out to per-tournament jobs
 * - Coordinator job runs in background worker
 */

export async function runLeagueEventPicksSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping league event picks sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping league event picks sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping league event picks sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue coordinator job (will fan out to per-tournament jobs)
  const job = await enqueueLeagueEventPicks(currentEvent.id, 'cron');
  logInfo('League event picks coordinator job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

export function registerLeagueEventPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-picks-trigger',
      pattern: '*/5 * * * *',
      async run() {
        logInfo('Cron trigger: league-event-picks-sync');
        try {
          await runLeagueEventPicksSync();
        } catch (error) {
          logError('Cron trigger failed: league-event-picks-sync', error);
        }
      },
    }),
  );
}
