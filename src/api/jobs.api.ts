import { Elysia } from 'elysia';

import { JobNotFoundError, listTriggerableJobs, triggerJob } from '../services/job-trigger.service';
import { getErrorMessage } from '../utils/errors';
import { logError } from '../utils/logger';

/**
 * Jobs Management API Routes
 *
 * Handles job-related HTTP endpoints:
 * - GET /jobs - List all available jobs
 * - POST /jobs/:name/trigger - Manually trigger a specific job
 */
export const jobsAPI = new Elysia({ prefix: '/jobs' })
  .get('/', () => {
    const jobs = listTriggerableJobs();
    return { success: true, jobs, count: jobs.length };
  })

  .post('/:name/trigger', async ({ params, set }) => {
    const { name } = params;

    try {
      const result = await triggerJob(name);

      if (result.kind === 'event-current-refresh') {
        return {
          success: true,
          message: result.message,
          refreshed: result.refreshed,
          ...(result.eventsSyncJobId !== undefined
            ? { eventsSyncJobId: result.eventsSyncJobId }
            : {}),
        };
      }

      if (result.kind === 'enqueued') {
        return {
          success: true,
          message: result.message,
          jobId: result.jobId,
        };
      }

      return { success: true, message: result.message };
    } catch (error) {
      if (error instanceof JobNotFoundError) {
        set.status = 404;
        return { success: false, error: error.message };
      }

      logError(`Manual job failed: ${name}`, error);
      set.status = 500;
      return { success: false, error: getErrorMessage(error) };
    }
  });
