import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isAfterMatchDay, isFPLSeason, isMatchDayTime } from '../utils/conditions';
import { loadFixturesByEvent } from '../utils/fixtures';
import { logError, logInfo } from '../utils/logger';
import {
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
  enqueueLiveFixtureCache,
  enqueueLiveBonusCache,
  enqueueLiveScoresSync,
} from './live-data.jobs';

/**
 * Live Data Cron Jobs
 *
 * Strategy:
 * - Cron triggers PRIMARY syncs (cache + DB) as background jobs
 * - PRIMARY jobs enqueue SECONDARY syncs on completion (cascade)
 * - Ensures data consistency and proper sequencing
 *
 * Jobs:
 * - event-lives-cache-update: Every 1 minute (real-time cache)
 * - event-lives-db-sync: Every 10 minutes (persistence + cascade)
 * - post-match-consolidation: 06:00, 08:00, 10:00 on match days (catch FPL overnight finalization)
 * - Secondary jobs (summary, explain, overall): Cascaded from DB sync
 */

export async function runLiveScores() {
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

  const fixtures = await loadFixturesByEvent(currentEvent.id);

  if (!isMatchDayTime(currentEvent, fixtures, now)) {
    logInfo('Skipping live scores - conditions not met', { eventId: currentEvent.id });
    return;
  }

  // Sync actual match scorelines (team_h_score / team_a_score) to DB
  // Runs every 15 min — distinct from event-lives (player fantasy points, 1-min/10-min)
  const job = await enqueueLiveScoresSync(currentEvent.id, 'cron');
  logInfo('Live scores job enqueued', { jobId: job.id, eventId: currentEvent.id });
}

async function runEventLivesCacheUpdate() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping cache update - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping cache update - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);

  if (!isMatchDayTime(currentEvent, fixtures, now)) {
    logInfo('Skipping cache update - not match time', { eventId: currentEvent.id });
    return;
  }

  // Enqueue as background job instead of direct execution
  await enqueueEventLivesCacheUpdate(currentEvent.id, 'cron');
  await enqueueLiveFixtureCache(currentEvent.id, 'cron');
  await enqueueLiveBonusCache(currentEvent.id, 'cron');
  logInfo('Cache update job enqueued', { eventId: currentEvent.id });
}

async function runEventLivesDbSync() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    logInfo('Skipping DB sync - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping DB sync - no current event');
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);

  if (!isMatchDayTime(currentEvent, fixtures, now)) {
    logInfo('Skipping DB sync - not match time', { eventId: currentEvent.id });
    return;
  }

  // Enqueue DB sync job (will trigger cascade on completion)
  const job = await enqueueEventLivesDbSync(currentEvent.id, 'cron');
  logInfo('DB sync job enqueued, will trigger cascade on completion', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

// Post-match consolidation: catches FPL overnight data finalization (bonus points, corrected
// scores, data_checked flag). Runs on match days in the morning AFTER isMatchDayTime has ended.
export async function runPostMatchConsolidation() {
  const now = new Date();
  if (!isFPLSeason(now)) {
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    return;
  }

  const fixtures = await loadFixturesByEvent(currentEvent.id);

  if (!isAfterMatchDay(currentEvent, fixtures, now)) {
    return;
  }

  const job = await enqueueEventLivesDbSync(currentEvent.id, 'cron');
  logInfo('Post-match consolidation job enqueued', { jobId: job.id, eventId: currentEvent.id });
}

export function registerLiveJobs(app: Elysia) {
  return (
    app
      // Event lives cache update - Every 1 minute during match hours (real-time)
      // Enqueues background job for cache-only updates
      .use(
        cron({
          name: 'event-lives-cache-trigger',
          pattern: '* * * * *',
          async run() {
            logInfo('Cron trigger: event-lives-cache-update');
            try {
              await runEventLivesCacheUpdate();
            } catch (error) {
              logError('Cron trigger failed: event-lives-cache-update', error);
            }
          },
        }),
      )

      // Event lives DB sync - Every 10 minutes during match hours (persistence)
      // Enqueues background job which triggers cascade on completion
      .use(
        cron({
          name: 'event-lives-db-trigger',
          pattern: '*/10 * * * *',
          async run() {
            logInfo('Cron trigger: event-lives-db-sync');
            try {
              await runEventLivesDbSync();
            } catch (error) {
              logError('Cron trigger failed: event-lives-db-sync', error);
            }
          },
        }),
      )

      // Live scores - Every 15 minutes (simplified for now)
      .use(
        cron({
          name: 'live-scores',
          pattern: '*/15 * * * *',
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

      // Post-match consolidation - 06:00, 08:00, 10:00 on match days
      // FPL finalises bonus points, corrects scores, and sets data_checked hours after matches end.
      // This catches those overnight updates that the 10-min live job misses once isMatchDayTime ends.
      .use(
        cron({
          name: 'post-match-consolidation',
          pattern: '0 6,8,10 * * *',
          async run() {
            logInfo('Cron trigger: post-match-consolidation');
            try {
              await runPostMatchConsolidation();
            } catch (error) {
              logError('Cron trigger failed: post-match-consolidation', error);
            }
          },
        }),
      )
  );
}
