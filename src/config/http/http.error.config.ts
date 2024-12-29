/**
 * Error code constants for HTTP and API errors
 * @const {Readonly<{VALIDATION_ERROR: string, NOT_FOUND: string, UNAUTHORIZED: string, FORBIDDEN: string, CONFLICT: string, INTERNAL_SERVER_ERROR: string, DATABASE_ERROR: string, BAD_REQUEST: string}>}
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
} as const;

/**
 * Type for error codes
 * @type {(typeof ErrorCode)[keyof typeof ErrorCode]}
 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
