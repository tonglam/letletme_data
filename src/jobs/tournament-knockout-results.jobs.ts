import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentKnockoutResults } from '../services/tournament-knockout-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentKnockoutResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament knockout results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament knockout results sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament knockout results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament knockout results sync started', { eventId: currentEvent.id });
  const result = await syncTournamentKnockoutResults(currentEvent.id);
  logInfo('Tournament knockout results sync completed', { eventId: currentEvent.id, ...result });
}

export function registerTournamentKnockoutResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-knockout-results-sync',
      pattern: '40 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-knockout-results-sync');
        try {
          await runTournamentKnockoutResultsSync();
          logInfo('Cron job completed: tournament-knockout-results-sync');
        } catch (error) {
          logError('Cron job failed: tournament-knockout-results-sync', error);
        }
      },
    }),
  );
}
