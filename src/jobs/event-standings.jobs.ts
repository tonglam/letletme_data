import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { syncEventStandings } from '../services/event-standings.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';

export async function runEventStandingsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping event standings sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping event standings sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping event standings sync - conditions not met', { eventId: currentEvent.id });
    return;
  }

  logInfo('Event standings sync started', { eventId: currentEvent.id });
  const result = await syncEventStandings(currentEvent.id);
  logInfo('Event standings sync completed', { eventId: currentEvent.id, ...result });
}

export function registerEventStandingsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'event-standings-sync',
      pattern: '0 12 * * *',
      async run() {
        logInfo('Cron job started: event-standings-sync');
        try {
          await runEventStandingsSync();
          logInfo('Cron job completed: event-standings-sync');
        } catch (error) {
          logError('Cron job failed: event-standings-sync', error);
        }
      },
    }),
  );
}
