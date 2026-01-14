import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncLeagueEventPicks } from '../services/league-event-picks.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

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

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping league event picks sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('League event picks sync started', { eventId: currentEvent.id });
  const result = await syncLeagueEventPicks(currentEvent.id);
  logInfo('League event picks sync completed', { eventId: currentEvent.id, ...result });
}

export function registerLeagueEventPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-picks-sync',
      pattern: '*/5 * * * *',
      async run() {
        logInfo('Cron job started: league-event-picks-sync');
        try {
          await runLeagueEventPicksSync();
          logInfo('Cron job completed: league-event-picks-sync');
        } catch (error) {
          logError('Cron job failed: league-event-picks-sync', error);
        }
      },
    }),
  );
}
