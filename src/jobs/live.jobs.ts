import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { getPostMatchResultsSlot } from '../domain/post-match-results';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isMatchDayTime } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { enqueueLiveSnapshot } from './live-data.jobs';
import { enqueueTournamentOfficialH2H } from './tournament-sync.jobs';

export const LIVE_SNAPSHOT_SCHEDULES = {
  cache: {
    name: 'live-snapshot-trigger',
    pattern: '* * * * *',
    persistEventLives: false,
  },
  persistence: {
    name: 'live-snapshot-persistence-trigger',
    pattern: '*/10 * * * *',
    persistEventLives: true,
  },
} as const;

/**
 * One coordinated one-minute job replaces four independently racing live jobs.
 * The job fetches event-live and fixtures concurrently, derives every live view
 * from that same pair, and publishes the Redis revision atomically. The larger
 * event-live/explain DB write is enabled every ten minutes only.
 */
export async function runLiveSnapshot(
  now = new Date(),
  persistEventLives = false,
): Promise<unknown | null> {
  const season = await seasonRepository.findCurrent();
  if (!(await isFPLSeason(season, now))) {
    logDebug('Skipping live snapshot - not FPL season', { month: now.getMonth() + 1 });
    return null;
  }

  const currentEvent = await getCurrentEvent(season);
  if (!currentEvent) {
    logInfo('Skipping live snapshot - no current event');
    return null;
  }

  const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
  if (!isMatchDayTime(currentEvent, fixtures, now)) {
    logInfo('Skipping live snapshot - not match time', { eventId: currentEvent.id });
    return null;
  }

  const job = await enqueueLiveSnapshot(season, currentEvent.id, 'cron', {
    persistEventLives,
    now,
  });
  if (job) {
    logInfo('Live snapshot job enqueued', {
      jobId: job.id,
      eventId: currentEvent.id,
      persistEventLives,
    });
  }
  try {
    await enqueueTournamentOfficialH2H(season, currentEvent.id, 'cron', {
      jobId: `official-h2h-e${currentEvent.id}-${now.toISOString().slice(0, 16)}`,
    });
  } catch (error) {
    logError('Failed to enqueue minute official H2H sync', error, {
      eventId: currentEvent.id,
    });
  }
  return job;
}

// Fixed morning ticks catch delayed FPL finalization and force canonical
// persistence even after the ordinary live polling window has closed.
export async function runPostMatchConsolidation(): Promise<unknown | null> {
  const now = new Date();
  const season = await seasonRepository.findCurrent();
  const currentEvent = await getCurrentEvent(season);
  if (!currentEvent) return null;

  const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
  const resultSlot = getPostMatchResultsSlot(currentEvent, fixtures, now);
  if (!resultSlot) return null;

  const job = await enqueueLiveSnapshot(season, currentEvent.id, 'cascade', {
    persistEventLives: true,
    // Provisional slots are useful for recovery, but the worker must not be
    // asked to publish a final event checkpoint until FPL marks data checked.
    finalizeEvent: resultSlot.startsWith('final-'),
    jobId: `live-snapshot-e${currentEvent.id}-post-${resultSlot}`,
  });
  if (job) {
    logInfo('Post-match live snapshot consolidation enqueued', {
      jobId: job.id,
      eventId: currentEvent.id,
      resultSlot,
    });
  }
  return job;
}

export function registerLiveJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: LIVE_SNAPSHOT_SCHEDULES.cache.name,
        pattern: LIVE_SNAPSHOT_SCHEDULES.cache.pattern,
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('live-snapshot', async () => {
              await runLiveSnapshot(new Date(), LIVE_SNAPSHOT_SCHEDULES.cache.persistEventLives);
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: LIVE_SNAPSHOT_SCHEDULES.persistence.name,
        pattern: LIVE_SNAPSHOT_SCHEDULES.persistence.pattern,
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('live-snapshot-persistence', async () => {
              // Persistence intent belongs to this scheduled callback, not to
              // its actual start minute. A delayed boundary tick still writes
              // the PostgreSQL checkpoint and triggers its cascades.
              await runLiveSnapshot(
                new Date(),
                LIVE_SNAPSHOT_SCHEDULES.persistence.persistEventLives,
              );
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'post-match-consolidation',
        pattern: '0 6,8,10 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('post-match-consolidation', async () => {
              await runPostMatchConsolidation();
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    );
}
