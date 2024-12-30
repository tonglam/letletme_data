// Error code constants for HTTP and API errors
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

// Type for error codes
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
