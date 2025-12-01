import { Elysia } from 'elysia';

import { getErrorMessage } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  enqueueEventsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from '../jobs/data-sync.queue';

// Job business logic functions (will be moved to jobs/ later)
import { getCurrentGameweek, isFPLSeason, isMatchHours, isWeekend } from '../utils/conditions';

async function runLiveScores() {
  const now = new Date();
  const shouldRun = isWeekend(now) && isFPLSeason(now) && isMatchHours(now);

  if (!shouldRun) {
    logInfo('Skipping live scores - conditions not met', {
      isWeekend: isWeekend(now),
      isFPLSeason: isFPLSeason(now),
      isMatchHours: isMatchHours(now),
    });
    return;
  }

  logInfo('Live scores sync started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement live scores logic
  logInfo('Live scores sync completed (placeholder)');
}

async function runWeeklyRankings() {
  const now = new Date();

  if (!isFPLSeason(now)) {
    logInfo('Skipping weekly rankings - not FPL season', { month: now.getMonth() + 1 });
    return;
  }

  logInfo('Weekly rankings started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement weekly rankings logic
  logInfo('Weekly rankings completed (placeholder)');
}

async function runMonthlyCleanup() {
  logInfo('Monthly cleanup started');

  const cleanupTasks = [
    'cleanup-old-logs',
    'cleanup-expired-cache',
    'cleanup-old-match-data',
    'optimize-database-indexes',
    'generate-monthly-reports',
  ];

  for (const task of cleanupTasks) {
    logInfo(`Cleanup task: ${task} (placeholder)`);
  }

  logInfo('Monthly cleanup completed');
}

/**
 * Jobs Management API Routes
 *
 * Handles job-related HTTP endpoints:
 * - GET /jobs - List all available jobs
 * - POST /jobs/:name/trigger - Manually trigger a specific job
 */

export const jobsAPI = new Elysia({ prefix: '/jobs' })
  .get('/', () => {
    const jobs = [
      {
        name: 'events-sync',
        description: 'Sync events from FPL API',
        schedule: 'Daily at 6:30 AM',
      },
      {
        name: 'teams-sync',
        description: 'Sync teams from FPL API',
        schedule: 'Daily at 6:34 AM',
      },
      {
        name: 'players-sync',
        description: 'Sync players from FPL API',
        schedule: 'Daily at 6:36 AM',
      },
      {
        name: 'phases-sync',
        description: 'Sync phases from FPL API',
        schedule: 'Daily at 6:38 AM',
      },
      { name: 'live-scores', description: 'Update live scores', schedule: 'Every 15 minutes' },
      {
        name: 'weekly-rankings',
        description: 'Update weekly rankings',
        schedule: 'Sunday at 10 PM',
      },
      {
        name: 'monthly-cleanup',
        description: 'Monthly maintenance',
        schedule: '1st of month at 2 AM',
      },
    ];

    return { success: true, jobs, count: jobs.length };
  })

  .post('/:name/trigger', async ({ params, set }) => {
    const { name } = params;

    const jobMap: Record<string, () => Promise<unknown>> = {
      'events-sync': () => enqueueEventsSyncJob('manual'),
      'teams-sync': () => enqueueTeamsSyncJob('manual'),
      'players-sync': () => enqueuePlayersSyncJob('manual'),
      'phases-sync': () => enqueuePhasesSyncJob('manual'),
      'live-scores': runLiveScores,
      'weekly-rankings': runWeeklyRankings,
      'monthly-cleanup': runMonthlyCleanup,
    };

    const job = jobMap[name];
    if (!job) {
      set.status = 404;
      return { success: false, error: `Job '${name}' not found` };
    }

    try {
      logInfo(`Manual job trigger: ${name}`);
      await job();
      logInfo(`Manual job completed: ${name}`);
      return { success: true, message: `Job '${name}' executed successfully` };
    } catch (error) {
      logError(`Manual job failed: ${name}`, error);
      set.status = 500;
      return { success: false, error: getErrorMessage(error) };
    }
  });
