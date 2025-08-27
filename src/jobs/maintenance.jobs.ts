import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { logError, logInfo } from '../utils/logger';

/**
 * Maintenance Cron Jobs
 *
 * Handles system maintenance and cleanup tasks:
 * - Monthly cleanup (1st of month at 2 AM)
 *
 * These jobs help keep the system optimized and clean.
 */

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

export function registerMaintenanceJobs(app: Elysia) {
  return (
    app
      // Monthly cleanup - 1st of month at 2 AM
      .use(
        cron({
          name: 'monthly-cleanup',
          pattern: '0 2 1 * *',
          async run() {
            logInfo('Cron job started: monthly-cleanup');
            try {
              await runMonthlyCleanup();
              logInfo('Cron job completed: monthly-cleanup');
            } catch (error) {
              logError('Cron job failed: monthly-cleanup', error);
            }
          },
        }),
      )
  );
}
