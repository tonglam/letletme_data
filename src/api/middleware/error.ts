/**
 * Error handling middleware module
 * @module api/middleware/error
 */

import { Request, Response } from 'express';
import { logApiError } from '../../utils/logger.util';
import { formatErrorResponse } from '../responses';

/**
 * Extended Error interface with optional status code and error code
 */
interface ErrorWithStatus extends Error {
  status?: number;
  code?: string;
}

/**
 * Determines the HTTP status code from an error object
 * @param error - Error object that may contain a status code
 * @returns HTTP status code (defaults to 500 if not specified)
 */
const getStatusCode = (error: ErrorWithStatus): number => error.status || 500;

/**
 * Global error handling middleware
 * Logs the error and sends a formatted error response
 * @param error - Error object with optional status and code
 * @param req - Express request object
 * @param res - Express response object
 */
export const errorMiddleware = (error: ErrorWithStatus, req: Request, res: Response): void => {
  logApiError(req, error);
  const statusCode = getStatusCode(error);
  res.status(statusCode).json(formatErrorResponse(error.message));
};
