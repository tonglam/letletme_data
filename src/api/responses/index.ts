/**
 * Response formatting utilities
 * @module api/responses
 */

import { APIResponse, ErrorResponse } from '../types';

/**
 * Formats a successful API response
 * @template T - The type of data being returned
 * @param data - The data to be included in the response
 * @returns Formatted success response
 */
export const formatResponse = <T>(data: T): APIResponse<T> => ({
  status: 'success',
  data,
});

/**
 * Formats an error API response
 * @param error - Error object or error message string
 * @returns Formatted error response
 */
export const formatErrorResponse = (error: Error | string): ErrorResponse => ({
  status: 'error',
  error: typeof error === 'string' ? error : error.message,
});
