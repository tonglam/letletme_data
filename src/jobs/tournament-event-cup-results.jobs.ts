import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentEventCupResults } from '../services/tournament-event-cup-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentEventCupResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament event cup results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event cup results sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event cup results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament event cup results sync started', { eventId: currentEvent.id });
  const result = await syncTournamentEventCupResults(currentEvent.id);
  logInfo('Tournament event cup results sync completed', {
    eventId: currentEvent.id,
    ...result,
  });
}

export function registerTournamentEventCupResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-cup-results-sync',
      pattern: '55 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-event-cup-results-sync');
        try {
          await runTournamentEventCupResultsSync();
          logInfo('Cron job completed: tournament-event-cup-results-sync');
        } catch (error) {
          logError('Cron job failed: tournament-event-cup-results-sync', error);
        }
      },
    }),
  );
}
