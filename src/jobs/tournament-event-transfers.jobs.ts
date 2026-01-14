import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import {
  syncTournamentEventTransfersPost,
  syncTournamentEventTransfersPre,
} from '../services/tournament-event-transfers.service';
import { isAfterMatchDay, isFPLSeason, isSelectTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

export async function runTournamentEventTransfersPostSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament event transfers post sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event transfers post sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event transfers post sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament event transfers post sync started', { eventId: currentEvent.id });
  const result = await syncTournamentEventTransfersPost(currentEvent.id);
  logInfo('Tournament event transfers post sync completed', {
    eventId: currentEvent.id,
    ...result,
  });
}

export async function runTournamentEventTransfersPreSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping tournament event transfers pre sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event transfers pre sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event transfers pre sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Tournament event transfers pre sync started', { eventId: currentEvent.id });
  const result = await syncTournamentEventTransfersPre(currentEvent.id);
  logInfo('Tournament event transfers pre sync completed', {
    eventId: currentEvent.id,
    ...result,
  });
}

export function registerTournamentEventTransfersPostJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-transfers-post-sync',
      pattern: '45 6,8,10 * * *',
      async run() {
        logInfo('Cron job started: tournament-event-transfers-post-sync');
        try {
          await runTournamentEventTransfersPostSync();
          logInfo('Cron job completed: tournament-event-transfers-post-sync');
        } catch (error) {
          logError('Cron job failed: tournament-event-transfers-post-sync', error);
        }
      },
    }),
  );
}

export function registerTournamentEventTransfersPreJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-transfers-pre-sync',
      pattern: '*/5 0-4,18-23 * * *',
      async run() {
        logInfo('Cron job started: tournament-event-transfers-pre-sync');
        try {
          await runTournamentEventTransfersPreSync();
          logInfo('Cron job completed: tournament-event-transfers-pre-sync');
        } catch (error) {
          logError('Cron job failed: tournament-event-transfers-pre-sync', error);
        }
      },
    }),
  );
}
