import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentPointsRaceResults } from '../services/tournament-points-race-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentPointsRaceResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament points race results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament points race results sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament points race results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament points race results sync started', { eventId: currentEvent.id });
  const result = await syncTournamentPointsRaceResults(currentEvent.id);
  logInfo('Tournament points race results sync completed', { eventId: currentEvent.id, ...result });
}

export function registerTournamentPointsRaceResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-points-race-results-sync',
      pattern: '20 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-points-race-results-sync');
        try {
          await runTournamentPointsRaceResultsSync();
          logInfo('Cron job completed: tournament-points-race-results-sync');
        } catch (error) {
          logError('Cron job failed: tournament-points-race-results-sync', error);
        }
      },
    }),
  );
}
