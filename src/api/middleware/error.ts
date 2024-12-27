import { Request, Response } from 'express';
import { logApiError } from '../../utils/logger';
import { formatErrorResponse } from '../responses';

interface ErrorWithStatus extends Error {
  status?: number;
  code?: string;
}

const getStatusCode = (error: ErrorWithStatus): number => error.status || 500;

export const errorMiddleware = (error: ErrorWithStatus, req: Request, res: Response): void => {
  logApiError(req, error);
  const statusCode = getStatusCode(error);
  res.status(statusCode).json(formatErrorResponse(error.message));
};
