import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getFinalizationAwarePostMatchResultsSlot } from '../domain/post-match-results';
import { getCurrentEvent } from '../services/events.service';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueTournamentEventResults } from './tournament-sync.jobs';
import { CRON_TIMEZONE } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

/**
 * Tournament Event Results Sync Trigger
 *
 * Strategy:
 * - Polls every 10 minutes for a bounded post-match result slot
 * - Uses deterministic hourly/final job IDs so duplicate cron ticks are idempotent
 * - Enqueues base job which triggers cascade (points-race, battle-race, knockout, etc.)
 * - Aligned with league-event-results for consistency
 */

export async function runTournamentEventResultsSync() {
  const now = new Date();
  const season = await seasonRepository.findCurrent();
  const currentEvent = await getCurrentEvent(season);
  if (!currentEvent) {
    logInfo('Skipping tournament event results sync - no current event');
    return;
  }

  const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
  const resultSlot = getFinalizationAwarePostMatchResultsSlot(currentEvent, fixtures, now);
  if (!resultSlot) {
    logInfo('Skipping tournament event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue base job (will trigger cascade on completion)
  const job = await enqueueTournamentEventResults(season, currentEvent.id, 'cron', {
    jobId: `tournament-event-results-e${currentEvent.id}-${resultSlot}`,
  });
  logInfo('Tournament event results job enqueued, will trigger cascade', {
    jobId: job.id,
    eventId: currentEvent.id,
    resultSlot,
  });
}

export function registerTournamentEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-results-trigger',
      pattern: '*/10 * * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          if (isStandaloneSchedulerEnabled()) return;
          await executeTrackedCron('tournament-event-results-sync', runTournamentEventResultsSync);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
