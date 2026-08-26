import { Elysia } from 'elysia';

import { JobNotFoundError, listTriggerableJobs, triggerJob } from '../services/job-trigger.service';
import {
  getHttpStatusFromError,
  getOrCreateRequestId,
  getPublicErrorCode,
  getPublicErrorMessage,
} from '../utils/errors';
import { logError } from '../utils/logger';
import { getJobsStatus } from '../services/jobs-status.service';
import { apiKeyFailureHttpResponse, verifyRequestApiKey } from './auth.guard';

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

  .get('/status', async ({ request, set }) => {
    // This endpoint includes queue, scheduler and publication state. Keep it
    // service-only even when the broader mutation guard is disabled in a local
    // environment.
    const verification = await verifyRequestApiKey(request);
    if (verification.status !== 'ok') {
      const failure = apiKeyFailureHttpResponse(verification.status);
      set.status = failure.httpStatus;
      return { success: false, error: failure.error };
    }
    return { success: true, ...(await getJobsStatus()) };
  })

  .post('/:name/trigger', async ({ params, body, request, set }) => {
    const { name } = params;

    try {
      const result = await triggerJob(name, body);

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

      if (result.kind === 'pending') {
        return {
          success: true,
          pending: true,
          message: result.message,
          ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
        };
      }

      return { success: true, message: result.message };
    } catch (error) {
      if (error instanceof JobNotFoundError) {
        set.status = 404;
        return { success: false, error: error.message };
      }

      const requestId = getOrCreateRequestId(request);
      logError(`Manual job failed: ${name}`, error, { requestId });
      const status = getHttpStatusFromError(error);
      set.status = status;
      set.headers['x-request-id'] = requestId;
      const code = getPublicErrorCode(error, status);
      return {
        success: false,
        error: getPublicErrorMessage(error, status),
        ...(code ? { code } : {}),
        ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
      };
    }
  });
