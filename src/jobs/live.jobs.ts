import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { getPostMatchResultsSlot } from '../domain/post-match-results';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isMatchDayTime } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';
import { enqueueLiveSnapshot } from './live-data.jobs';
import { enqueuePlayerStatsSyncJob } from './data-sync-enqueue';
import { LIVE_POLL_MS, registerLiveLifecycleTimer } from '../services/live-lifecycle-orchestrator';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

export const LIVE_SNAPSHOT_SCHEDULES = {
  lifecycle: { name: 'live-lifecycle', intervalMs: LIVE_POLL_MS },
} as const;

/**
 * One coordinated 30-second job replaces four independently racing live jobs.
 * The job fetches event-live and fixtures concurrently, derives every live view
 * from that same pair, and publishes the Redis revision atomically. The larger
 * event-live/explain DB write is coalesced to at most once every ten minutes.
 */
export async function runLiveSnapshot(now = new Date()): Promise<unknown | null> {
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
    now,
    lifecycleState: 'LIVE_ACTIVE',
    expectedNextCheckAt: new Date(now.getTime() + LIVE_POLL_MS),
  });
  if (job) {
    logInfo('Live snapshot job enqueued', {
      jobId: job.id,
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
    // Provisional slots are useful for recovery, but the worker must not be
    // asked to publish a final event checkpoint until FPL marks data checked.
    finalizeEvent: resultSlot.startsWith('final-'),
    lifecycleState: resultSlot.startsWith('final-') ? 'FINALIZED' : 'GW_REVIEW',
    jobId: `live-snapshot-e${currentEvent.id}-post-${resultSlot}`,
  });
  if (job) {
    logInfo('Post-match live snapshot consolidation enqueued', {
      jobId: job.id,
      eventId: currentEvent.id,
      resultSlot,
    });
  }
  if (resultSlot.startsWith('final-')) {
    const playerStatsJob = await enqueuePlayerStatsSyncJob(season, 'cascade', {
      eventId: currentEvent.id,
      jobId: `player-stats-final-e${currentEvent.id}-${resultSlot}`,
      removeOnSettle: true,
    });
    if (playerStatsJob) {
      logInfo('Final player stats repair enqueued', {
        jobId: playerStatsJob.id,
        eventId: currentEvent.id,
        resultSlot,
      });
    }
  }
  return job;
}

export function registerLiveJobs(app: Elysia) {
  return registerLiveLifecycleTimer(app).use(
    cron({
      name: 'post-match-consolidation',
      pattern: '0 6,8,10 * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          if (isStandaloneSchedulerEnabled()) return;
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
