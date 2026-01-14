import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentEventResults } from '../services/tournament-event-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

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

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament event results sync started', { eventId: currentEvent.id });
  const result = await syncTournamentEventResults(currentEvent.id);
  logInfo('Tournament event results sync completed', { eventId: currentEvent.id, ...result });
}

export function registerTournamentEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-results-sync',
      pattern: '10 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-event-results-sync');
        try {
          await runTournamentEventResultsSync();
          logInfo('Cron job completed: tournament-event-results-sync');
        } catch (error) {
          logError('Cron job failed: tournament-event-results-sync', error);
        }
      },
    }),
  );
}
