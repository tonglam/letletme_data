import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';
import { enqueueTournamentEventResults } from './tournament-sync.jobs';

/**
 * Tournament Event Results Sync Trigger
 *
 * Strategy:
 * - Runs every 10 minutes during after-match-day window
 * - Enqueues base job which triggers cascade (points-race, battle-race, knockout, etc.)
 * - Aligned with league-event-results for consistency
 */

export async function runTournamentEventResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament event results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event results sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue base job (will trigger cascade on completion)
  const job = await enqueueTournamentEventResults(currentEvent.id, 'cron');
  logInfo('Tournament event results job enqueued, will trigger cascade', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

export function registerTournamentEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-results-trigger',
      pattern: '*/10 * * * *',
      async run() {
        logInfo('Cron trigger: tournament-event-results-sync');
        try {
          await runTournamentEventResultsSync();
        } catch (error) {
          logError('Cron trigger failed: tournament-event-results-sync', error);
        }
      },
    }),
  );
}
