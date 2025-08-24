import cron from 'node-cron';

import { syncEvents } from '../api/events';
import { logError, logInfo } from '../utils/logger';

/**
 * Events Sync Job
 * Runs daily at 6:30 AM to sync events from FPL API
 */

// Job configuration
const EVENTS_SYNC_SCHEDULE = '30 6 * * *'; // Daily at 6:30 AM
const JOB_NAME = 'events-sync';

// Job function
async function eventsJobHandler(): Promise<void> {
  const startTime = Date.now();

  try {
    logInfo(`Starting ${JOB_NAME} job`);

    await syncEvents();

    const duration = Date.now() - startTime;
    logInfo(`${JOB_NAME} job completed successfully`, {
      durationMs: duration,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logError(`${JOB_NAME} job failed`, error, {
      durationMs: duration,
    });

    // Don't throw - let the job continue running
    // In production, you might want to send alerts here
  }
}

// Create and start the cron job
export function startEventsJob(): void {
  logInfo(`Scheduling ${JOB_NAME} job`, { schedule: EVENTS_SYNC_SCHEDULE });

  const job = cron.schedule(EVENTS_SYNC_SCHEDULE, eventsJobHandler, {
    scheduled: false, // Don't start immediately
    name: JOB_NAME,
    timezone: 'UTC',
  });

  // Start the job
  job.start();

  logInfo(`${JOB_NAME} job started successfully`);
}

// Stop the job (for graceful shutdown)
export function stopEventsJob(): void {
  const job = cron.getTasks().get(JOB_NAME);
  if (job) {
    job.stop();
    logInfo(`${JOB_NAME} job stopped`);
  }
}

// Manual trigger for testing or API calls
export async function triggerEventsJob(): Promise<void> {
  logInfo(`Manually triggering ${JOB_NAME} job`);
  await eventsJobHandler();
}

// Export job metadata
export const eventsJobConfig = {
  name: JOB_NAME,
  schedule: EVENTS_SYNC_SCHEDULE,
  description: 'Sync events from FPL API daily',
  handler: eventsJobHandler,
};
