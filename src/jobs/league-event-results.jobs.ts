import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getPostMatchResultsSlot } from '../domain/post-match-results';
import { getCurrentEvent } from '../services/events.service';
import { fixtureRepository } from '../repositories/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { enqueueLeagueEventResults } from './league-sync.jobs';
import type { LeagueSyncJobSource } from './league-sync.jobs';
import { CRON_TIMEZONE } from '../utils/timezone';

/**
 * League Event Results Sync Trigger
 *
 * Strategy:
 * - Polls every 10 minutes for a bounded post-match result slot
 * - Uses deterministic hourly/final job IDs so duplicate cron ticks are idempotent
 * - Enqueues coordinator job which fans out to per-tournament jobs
 * - Uses fresh event_lives data from DB for calculations
 */

export async function runLeagueEventResultsSync(options?: {
  skipMatchWindowCheck?: boolean;
  source?: LeagueSyncJobSource;
}) {
  const source = options?.source ?? 'cron';
  const skipMatchWindowCheck = options?.skipMatchWindowCheck ?? false;
  const now = new Date();
  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping league event results sync - no current event');
    return;
  }

  const fixtures = await fixtureRepository.findByEvent(currentEvent.id);
  const resultSlot = skipMatchWindowCheck
    ? null
    : getPostMatchResultsSlot(currentEvent, fixtures, now);
  if (!skipMatchWindowCheck && !resultSlot) {
    logInfo('Skipping league event results sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue coordinator job (will fan out to per-tournament jobs)
  const job = await enqueueLeagueEventResults(currentEvent.id, source, {
    ...(resultSlot
      ? { jobId: `league-event-results-e${currentEvent.id}-coordinator-${resultSlot}` }
      : {}),
  });
  logInfo('League event results coordinator job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
    source,
    skipMatchWindowCheck,
    resultSlot,
  });
}

export function registerLeagueEventResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'league-event-results-trigger',
      pattern: '*/10 * * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron('league-event-results-sync', runLeagueEventResultsSync);
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
