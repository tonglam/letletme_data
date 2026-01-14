import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentEventPicks } from '../services/tournament-event-picks.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentEventPicksSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament event picks sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event picks sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event picks sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament event picks sync started', { eventId: currentEvent.id });
  const result = await syncTournamentEventPicks(currentEvent.id);
  logInfo('Tournament event picks sync completed', { eventId: currentEvent.id, ...result });
}

export function registerTournamentEventPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-picks-sync',
      pattern: '*/5 0-4,18-23 * * *',
      async run() {
        logInfo('Cron job started: tournament-event-picks-sync');
        try {
          await runTournamentEventPicksSync();
          logInfo('Cron job completed: tournament-event-picks-sync');
        } catch (error) {
          logError('Cron job failed: tournament-event-picks-sync', error);
        }
      },
    }),
  );
}
