import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { syncEventLiveExplain } from '../services/event-live-explains.service';
import { syncEventLives } from '../services/event-lives.service';
import { syncEventLiveSummary } from '../services/event-live-summaries.service';
import { syncEventOverallResult } from '../services/event-overall-results.service';
import { getCurrentEvent } from '../services/events.service';
import { getFixturesByEvent } from '../services/fixtures.service';
import { getCurrentGameweek, isFPLSeason, isMatchDay, isMatchDayTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

/**
 * Live Data Cron Jobs
 *
 * Handles real-time and periodic data updates:
 * - Event lives sync (every 5 minutes during match hours)
 * - Live scores (every 15 minutes during match hours)
 *
 * These jobs are conditional and only run when appropriate.
 */

async function runLiveScores() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping live scores - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping live scores - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);

  const shouldRun = isMatchDayTime(currentEvent, fixtures, now);

  if (!shouldRun) {
    logInfo('Skipping live scores - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Live scores sync started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement live scores logic
  logInfo('Live scores sync completed (placeholder)');
}

async function runEventLivesSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping event lives sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping event lives sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);

  if (!isMatchDayTime(currentEvent, fixtures, now)) {
    logInfo('Skipping event lives sync - conditions not met', { eventId: currentEvent.id });
    return;
  }

  logInfo('Event lives sync started', { eventId: currentEvent.id });
  await syncEventLives(currentEvent.id);
  logInfo('Event lives sync completed', { eventId: currentEvent.id });
}

async function runEventLiveSummarySync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping event live summary sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping event live summary sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping event live summary sync - conditions not met', { eventId: currentEvent.id });
    return;
  }

  logInfo('Event live summary sync started', { eventId: currentEvent.id });
  await syncEventLiveSummary();
  logInfo('Event live summary sync completed', { eventId: currentEvent.id });
}

async function runEventLiveExplainSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping event live explain sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping event live explain sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping event live explain sync - conditions not met', { eventId: currentEvent.id });
    return;
  }

  logInfo('Event live explain sync started', { eventId: currentEvent.id });
  await syncEventLiveExplain(currentEvent.id);
  logInfo('Event live explain sync completed', { eventId: currentEvent.id });
}

async function runEventOverallResultSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping event overall result sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping event overall result sync - no current event');
    return;
  }

  const fixtures = await getFixturesByEvent(currentEvent.id);
  if (!isMatchDay(currentEvent, fixtures, now)) {
    logInfo('Skipping event overall result sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  logInfo('Event overall result sync started', { eventId: currentEvent.id });
  await syncEventOverallResult();
  logInfo('Event overall result sync completed', { eventId: currentEvent.id });
}

export function registerLiveJobs(app: Elysia) {
  return (
    app
      // Event lives sync - Every 5 minutes during match hours
      .use(
        cron({
          name: 'event-lives-sync',
          pattern: '*/5 * * * *',
          async run() {
            logInfo('Cron job started: event-lives-sync');
            try {
              await runEventLivesSync();
              logInfo('Cron job completed: event-lives-sync');
            } catch (error) {
              logError('Cron job failed: event-lives-sync', error);
            }
          },
        }),
      )

      // Event live summary sync - Matchday snapshots
      .use(
        cron({
          name: 'event-live-summary-sync',
          pattern: '5 6,8,10 * * *',
          async run() {
            logInfo('Cron job started: event-live-summary-sync');
            try {
              await runEventLiveSummarySync();
              logInfo('Cron job completed: event-live-summary-sync');
            } catch (error) {
              logError('Cron job failed: event-live-summary-sync', error);
            }
          },
        }),
      )

      // Event live explain sync - Matchday snapshots
      .use(
        cron({
          name: 'event-live-explain-sync',
          pattern: '8 6,8,10 * * *',
          async run() {
            logInfo('Cron job started: event-live-explain-sync');
            try {
              await runEventLiveExplainSync();
              logInfo('Cron job completed: event-live-explain-sync');
            } catch (error) {
              logError('Cron job failed: event-live-explain-sync', error);
            }
          },
        }),
      )

      // Event overall result sync - Matchday snapshots
      .use(
        cron({
          name: 'event-overall-result-sync',
          pattern: '2 6,8,10 * * *',
          async run() {
            logInfo('Cron job started: event-overall-result-sync');
            try {
              await runEventOverallResultSync();
              logInfo('Cron job completed: event-overall-result-sync');
            } catch (error) {
              logError('Cron job failed: event-overall-result-sync', error);
            }
          },
        }),
      )

      // Live scores - Every 15 minutes (simplified for now)
      .use(
        cron({
          name: 'live-scores',
          pattern: '*/15 * * * *', // Every 15 minutes
          async run() {
            logInfo('Cron job started: live-scores');
            try {
              await runLiveScores();
              logInfo('Cron job completed: live-scores');
            } catch (error) {
              logError('Cron job failed: live-scores', error);
            }
          },
        }),
      )
  );
}
