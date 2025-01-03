/**
 * HTTP Response Handling
 * @module infrastructure/http/client/response
 */

import { AxiosError, AxiosResponse } from 'axios';
import { Response } from 'express';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { HTTP_STATUS } from '../../../config/http/http.config';
import { APIError, APIResponse, ErrorDetails, HttpMethod, RequestMetrics } from './types';
import { createErrorFromStatus, createMonitor } from './utils';

/**
 * Log levels based on duration
 */
const logMetricsByDuration = (logData: Record<string, unknown>, logger: Logger) =>
  flow((duration: number) => {
    if (duration >= 5000)
      logger.error({ ...logData, severity: 'CRITICAL' }, 'Critical response time');
    else if (duration >= 2000)
      logger.error({ ...logData, severity: 'ERROR' }, 'High response time');
    else if (duration >= 1000) logger.warn({ ...logData, severity: 'WARN' }, 'Slow response');
    else if (logData.error) logger.error(logData, 'Request failed');
    else logger.info(logData, 'Request completed');
  });

/**
 * Tracks response metrics
 */
const trackMetrics = (metrics: RequestMetrics, logger: Logger): void => {
  const { path, method, duration, status, error } = metrics;
  const logData = {
    path,
    method,
    duration: `${duration}ms`,
    status,
    ...(error && { error }),
  };

  logMetricsByDuration(logData, logger)(duration);
};

/**
 * Validates response status
 */
const validateStatus = (response: AxiosResponse): AxiosResponse => {
  const { status } = response;
  if (status >= HTTP_STATUS.CLIENT_ERROR_MIN && status <= HTTP_STATUS.CLIENT_ERROR_MAX) {
    throw createErrorFromStatus(status, 'Client error', response.data as Record<string, unknown>);
  }
  if (status >= HTTP_STATUS.SERVER_ERROR_MIN && status <= HTTP_STATUS.SERVER_ERROR_MAX) {
    throw createErrorFromStatus(status, 'Server error', response.data as Record<string, unknown>);
  }
  return response;
};

/**
 * Extracts response data
 */
const extractData = (response: AxiosResponse): unknown => response.data;

/**
 * Handles response errors
 */
const handleError =
  (logger: Logger) =>
  (error: AxiosError): never => {
    if (error.response) {
      const { status, data } = error.response;
      logger.error({ status, data }, 'Response error');
      throw createErrorFromStatus(status, error.message, data as Record<string, unknown>);
    }

    if (error.request) {
      logger.error({ error: error.request }, 'Request error');
      throw createErrorFromStatus(HTTP_STATUS.SERVICE_UNAVAILABLE, 'No response received', {
        request: error.request,
      });
    }

    logger.error({ error: error.message }, 'Network error');
    throw createErrorFromStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Network error', {
      message: error.message,
    });
  };

/**
 * Creates response interceptor for Axios
 */
export const createResponseInterceptor = (logger: Logger) => ({
  onSuccess: (response: AxiosResponse): unknown => pipe(response, validateStatus, extractData),
  onError: handleError(logger),
});

/**
 * Handles API response with monitoring for Express
 */
export const handleAPIResponse =
  <T>(res: Response, logger: Logger) =>
  (task: TE.TaskEither<APIError, APIResponse<T>>): Promise<Response> =>
    pipe(
      task,
      TE.fold(
        (error) => {
          const details = error.details as ErrorDetails;
          const metrics = createMonitor().end(res.req.path, res.req.method as HttpMethod, {
            status: details.httpStatus || HTTP_STATUS.INTERNAL_SERVER_ERROR,
            error,
          });
          trackMetrics(metrics, logger);
          const errorResponse = {
            status: 'error' as const,
            error: error.message,
          };
          if (error.details) {
            Object.assign(errorResponse, { details: error.details as Record<string, unknown> });
          }
          return T.of(
            res.status(details.httpStatus || HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse),
          );
        },
        (success) => {
          const metrics = createMonitor().end(res.req.path, res.req.method as HttpMethod, {
            status: 200,
          });
          trackMetrics(metrics, logger);
          return T.of(res.status(200).json(success));
        },
      ),
    )();
