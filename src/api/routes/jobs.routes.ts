import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { logApiError, logApiRequest } from '../../utils/logger';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const jobRouter = ({ jobService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
  const getPendingJobs: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get pending jobs');

    pipe(
      await jobService.getPendingJobs()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (jobs) => res.json(formatResponse(jobs)),
      ),
    );
  };

  const getFailedJobs: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get failed jobs');

    pipe(
      await jobService.getFailedJobs()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (jobs) => res.json(formatResponse(jobs)),
      ),
    );
  };

  const getCompletedJobs: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get completed jobs');

    pipe(
      await jobService.getCompletedJobs()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (jobs) => res.json(formatResponse(jobs)),
      ),
    );
  };

  const retryJob: RequestHandler = async (req, res) => {
    const jobId = req.params.id;
    logApiRequest(req as ApiRequest, 'Retry job', { jobId });

    pipe(
      await jobService.retryJob(jobId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          return res.status(500).json(formatErrorResponse(error as Error));
        },
        () => res.json(formatResponse({ message: 'Job retry initiated' })),
      ),
    );
  };

  const removeJob: RequestHandler = async (req, res) => {
    const jobId = req.params.id;
    logApiRequest(req as ApiRequest, 'Remove job', { jobId });

    pipe(
      await jobService.removeJob(jobId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          return res.status(500).json(formatErrorResponse(error as Error));
        },
        () => res.json(formatResponse({ message: 'Job removed successfully' })),
      ),
    );
  };

  // Register routes
  router.get('/jobs/pending', getPendingJobs);
  router.get('/jobs/failed', getFailedJobs);
  router.get('/jobs/completed', getCompletedJobs);
  router.post('/jobs/:id/retry', retryJob);
  router.delete('/jobs/:id', removeJob);

  return router;
};
