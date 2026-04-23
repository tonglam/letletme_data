import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueTournamentEventPicks } from './tournament-sync.jobs';

/**
 * Tournament Event Picks Sync Trigger
 *
 * Strategy:
 * - Runs every 5 minutes during select time (no hour restrictions)
 * - Enqueues background job for reliable execution with retry
 */

export async function runTournamentEventPicksSync() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logInfo('Skipping tournament event picks sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event picks sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event picks sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue job for background processing
  const job = await enqueueTournamentEventPicks(currentEvent.id, 'cron');
  logInfo('Tournament event picks job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

export function registerTournamentEventPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-picks-trigger',
      pattern: '*/5 * * * *',
      async run() {
        try {
          await executeTrackedCron('tournament-event-picks-sync', runTournamentEventPicksSync);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
