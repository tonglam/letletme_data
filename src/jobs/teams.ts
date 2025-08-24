import cron from 'node-cron';

import { syncTeams } from '../api/teams';
import { logError, logInfo } from '../utils/logger';

/**
 * Teams Sync Job - Background Data Processing
 *
 * Demonstrates automated data flow triggered by cron schedule
 */

// Job configuration
const TEAMS_SYNC_SCHEDULE = '34 6 * * *'; // Daily at 6:34 AM (2 minutes after events)
const JOB_NAME = 'teams-sync';

// Job function - wrapper around the core sync logic
async function teamsJobHandler(): Promise<void> {
  const startTime = Date.now();

  try {
    logInfo(`Starting ${JOB_NAME} background job`);

    // Call the same sync function used by manual API calls
    // This shows how both manual and automated triggers use the same core logic
    await syncTeams();

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
  }
}

// Create and start the cron job
export function startTeamsJob(): void {
  logInfo(`Scheduling ${JOB_NAME} job`, {
    schedule: TEAMS_SYNC_SCHEDULE,
    description: 'Daily teams sync from FPL API',
  });

  const job = cron.schedule(TEAMS_SYNC_SCHEDULE, teamsJobHandler, {
    scheduled: false, // Don't start immediately - we'll start it manually
    name: JOB_NAME,
    timezone: 'UTC', // Always use UTC for consistency
  });

  // Start the job
  job.start();

  logInfo(`${JOB_NAME} job started successfully`);
}

// Stop the job (for graceful shutdown)
export function stopTeamsJob(): void {
  const job = cron.getTasks().get(JOB_NAME);
  if (job) {
    job.stop();
    logInfo(`${JOB_NAME} job stopped`);
  }
}

// Manual trigger for testing or emergency sync
export async function triggerTeamsJob(): Promise<void> {
  logInfo(`Manually triggering ${JOB_NAME} job`);
  await teamsJobHandler();
}

// Export job metadata for monitoring/health checks
export const teamsJobConfig = {
  name: JOB_NAME,
  schedule: TEAMS_SYNC_SCHEDULE,
  description: 'Sync teams from FPL API daily',
  handler: teamsJobHandler,
  nextRun: () => {
    const job = cron.getTasks().get(JOB_NAME);
    return job ? 'Running' : 'Stopped';
  },
};
