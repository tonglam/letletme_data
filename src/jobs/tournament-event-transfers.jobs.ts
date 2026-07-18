import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { getCurrentEvent } from '../services/events.service';
import { isFPLSeason, isSelectTime } from '../utils/conditions';
import { fixtureRepository } from '../repositories/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logDebug, logInfo } from '../utils/logger';
import { enqueueTournamentTransfersPre } from './tournament-sync.jobs';
import { CRON_TIMEZONE } from '../utils/timezone';

/**
 * Tournament Event Transfers Sync Triggers
 *
 * Pre-Transfer (Before Deadline):
 * - Runs every 5 minutes during select time (no hour restrictions)
 * - Tracks transfers as they happen
 *
 * Post-Transfer (After Deadline):
 * - Part of cascade (triggered by tournament-event-results completion)
 * - No separate cron needed
 */

export async function runTournamentEventTransfersPreSync() {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logDebug('Skipping tournament event transfers pre sync - not FPL season', {
      month: now.getMonth() + 1,
    });
    return;
  }

  const currentEvent = await getCurrentEvent();
  if (!currentEvent) {
    logInfo('Skipping tournament event transfers pre sync - no current event');
    return;
  }

  const fixtures = await fixtureRepository.findByEvent(currentEvent.id);
  if (!isSelectTime(currentEvent, fixtures, now)) {
    logInfo('Skipping tournament event transfers pre sync - conditions not met', {
      eventId: currentEvent.id,
    });
    return;
  }

  // Enqueue job for background processing
  const job = await enqueueTournamentTransfersPre(currentEvent.id, 'cron');
  logInfo('Tournament event transfers pre job enqueued', {
    jobId: job.id,
    eventId: currentEvent.id,
  });
}

// Post-transfer is part of cascade, no separate function needed
export async function runTournamentEventTransfersPostSync() {
  // This is now handled by cascade from tournament-event-results
  // Keeping function for backward compatibility with manual triggers
  logInfo('Tournament transfers post is now part of cascade');
}

export function registerTournamentEventTransfersPostJobs(app: Elysia) {
  // Post-transfer is now part of cascade, no cron needed
  // Return app unchanged for backward compatibility
  return app;
}

export function registerTournamentEventTransfersPreJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'tournament-event-transfers-pre-trigger',
      pattern: '*/5 * * * *',
      timezone: CRON_TIMEZONE,
      async run() {
        try {
          await executeTrackedCron(
            'tournament-event-transfers-pre-sync',
            runTournamentEventTransfersPreSync,
          );
        } catch {
          // Failure details are already emitted by runTrackedJob.
        }
      },
    }),
  );
}
