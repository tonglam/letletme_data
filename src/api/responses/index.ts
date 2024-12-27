import { APIResponse, ErrorResponse } from '../types';

export const formatResponse = <T>(data: T): APIResponse<T> => ({
  status: 'success',
  data,
});

export const formatErrorResponse = (error: Error | string): ErrorResponse => ({
  status: 'error',
  error: typeof error === 'string' ? error : error.message,
});
