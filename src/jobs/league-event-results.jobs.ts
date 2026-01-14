import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncLeagueEventResults } from '../services/league-event-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

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

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping league event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('League event results sync started', { eventId: currentEvent.id });
  const result = await syncLeagueEventResults(currentEvent.id);
  logInfo('League event results sync completed', { eventId: currentEvent.id, ...result });
}

export function registerLeagueEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-results-sync',
      pattern: '0 8,10,12 * * *',
      async run() {
        logInfo('Cron job started: league-event-results-sync');
        try {
          await runLeagueEventResultsSync();
          logInfo('Cron job completed: league-event-results-sync');
        } catch (error) {
          logError('Cron job failed: league-event-results-sync', error);
        }
      },
    }),
  );
}
