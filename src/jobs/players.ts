import cron from 'node-cron';

import { syncPlayers } from '../api/players';
import { logError, logInfo } from '../utils/logger';

/**
 * Players Sync Job - Background Data Processing
 *
 * Demonstrates automated player data flow triggered by cron schedule
 */

// Job configuration
const PLAYERS_SYNC_SCHEDULE = '36 6 * * *'; // Daily at 6:36 AM (4 minutes after teams)
const JOB_NAME = 'players-sync';

// Job function - wrapper around the core sync logic
async function playersJobHandler(): Promise<void> {
  const startTime = Date.now();

  try {
    logInfo(`Starting ${JOB_NAME} background job`);

    // Call the sync function from the API layer
    // This ensures consistency between manual and automated triggers
    await syncPlayers();

    const duration = Date.now() - startTime;
    logInfo(`${JOB_NAME} job completed successfully`, {
      durationMs: duration,
      durationSeconds: Math.round(duration / 1000),
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logError(`${JOB_NAME} job failed`, error, {
      durationMs: duration,
      durationSeconds: Math.round(duration / 1000),
    });

    // Log error but don't throw - let the job continue running
    // In production, you might want to:
    // - Send alerts to monitoring systems
    // - Retry with exponential backoff
    // - Update health check status
    // - Store failed sync metadata for manual investigation
  }
}

// Create and start the cron job
export function startPlayersJob(): void {
  logInfo(`Scheduling ${JOB_NAME} job`, {
    schedule: PLAYERS_SYNC_SCHEDULE,
    description: 'Daily players sync from FPL API',
  });

  const job = cron.schedule(PLAYERS_SYNC_SCHEDULE, playersJobHandler, {
    scheduled: false, // Don't start immediately - we'll start it manually
    name: JOB_NAME,
    timezone: 'UTC', // Always use UTC for consistency
  });

  // Start the job
  job.start();

  logInfo(`${JOB_NAME} job started successfully`);
}

// Stop the job (for graceful shutdown)
export function stopPlayersJob(): void {
  const job = cron.getTasks().get(JOB_NAME);
  if (job) {
    job.stop();
    logInfo(`${JOB_NAME} job stopped`);
  }
}

// Manual trigger for testing or emergency sync
export async function triggerPlayersJob(): Promise<void> {
  logInfo(`Manually triggering ${JOB_NAME} job`);
  await playersJobHandler();
}

// Export job metadata for monitoring/health checks
export const playersJobConfig = {
  name: JOB_NAME,
  schedule: PLAYERS_SYNC_SCHEDULE,
  description: 'Sync players from FPL API daily',
  handler: playersJobHandler,
  nextRun: () => {
    const job = cron.getTasks().get(JOB_NAME);
    return job ? 'Running' : 'Stopped';
  },
};
