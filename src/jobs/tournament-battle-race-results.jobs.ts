import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { syncTournamentBattleRaceResults } from '../services/tournament-battle-race-results.service';
import { isAfterMatchDay, isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentBattleRaceResultsSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament battle race results sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament battle race results sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament battle race results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament battle race results sync started', { eventId: currentEvent.id });
  const result = await syncTournamentBattleRaceResults(currentEvent.id);
  logInfo('Tournament battle race results sync completed', { eventId: currentEvent.id, ...result });
}

export function registerTournamentBattleRaceResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-battle-race-results-sync',
      pattern: '30 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-battle-race-results-sync');
        try {
          await runTournamentBattleRaceResultsSync();
          logInfo('Cron job completed: tournament-battle-race-results-sync');
        } catch (error) {
          logError('Cron job failed: tournament-battle-race-results-sync', error);
        }
      },
    }),
  );
}
