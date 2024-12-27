import { ErrorCode } from '../../../config/http/http.error.config';

export interface ErrorResponse {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly stack?: string;
}

export interface ErrorParams {
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface APIError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly isOperational: boolean;
  readonly _tag: string;
  toJSON(): ErrorResponse;
}

// Error configuration mapping
export const ERROR_CONFIG = {
  [ErrorCode.VALIDATION_ERROR]: { httpStatus: 400, isOperational: true, _tag: 'ValidationError' },
  [ErrorCode.NOT_FOUND]: { httpStatus: 404, isOperational: true, _tag: 'NotFoundError' },
  [ErrorCode.UNAUTHORIZED]: { httpStatus: 401, isOperational: true, _tag: 'UnauthorizedError' },
  [ErrorCode.FORBIDDEN]: { httpStatus: 403, isOperational: true, _tag: 'ForbiddenError' },
  [ErrorCode.CONFLICT]: { httpStatus: 409, isOperational: true, _tag: 'ConflictError' },
  [ErrorCode.INTERNAL_SERVER_ERROR]: {
    httpStatus: 500,
    isOperational: false,
    _tag: 'InternalServerError',
  },
  [ErrorCode.DATABASE_ERROR]: { httpStatus: 503, isOperational: false, _tag: 'DatabaseError' },
  [ErrorCode.BAD_REQUEST]: { httpStatus: 400, isOperational: true, _tag: 'BadRequestError' },
} as const;

// Type guard functions
export const isAPIError = (error: unknown): error is APIError =>
  error instanceof Error && '_tag' in error && 'code' in error && 'httpStatus' in error;

export const isValidationError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'ValidationError';

export const isNotFoundError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'NotFoundError';

export const isUnauthorizedError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'UnauthorizedError';

export const isForbiddenError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'ForbiddenError';

export const isConflictError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'ConflictError';

export const isInternalServerError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'InternalServerError';

export const isDatabaseError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'DatabaseError';

export const isBadRequestError = (error: unknown): error is APIError =>
  isAPIError(error) && error._tag === 'BadRequestError';

// Single error creation function
const createError = (code: ErrorCode, { message, details }: ErrorParams): APIError => {
  const error = new Error(message) as APIError;
  const config = ERROR_CONFIG[code];

  Object.defineProperties(error, {
    code: { value: code, enumerable: true },
    httpStatus: { value: config.httpStatus, enumerable: true },
    details: { value: Object.freeze(details), enumerable: true },
    correlationId: { value: undefined, enumerable: true, writable: true },
    isOperational: { value: config.isOperational, enumerable: true },
    _tag: { value: config._tag, enumerable: true },
    toJSON: {
      value: () =>
        Object.freeze({
          code,
          message: error.message,
          details: error.details,
          correlationId: error.correlationId,
          ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
        }),
    },
  });

  Error.captureStackTrace(error, createError);
  return error;
};

// Pure factory functions for specific error types
export const createValidationError = (params: ErrorParams): APIError =>
  createError(ErrorCode.VALIDATION_ERROR, params);

export const createNotFoundError = (params: ErrorParams): APIError =>
  createError(ErrorCode.NOT_FOUND, params);

export const createUnauthorizedError = (params: ErrorParams): APIError =>
  createError(ErrorCode.UNAUTHORIZED, params);

export const createForbiddenError = (params: ErrorParams): APIError =>
  createError(ErrorCode.FORBIDDEN, params);

export const createConflictError = (params: ErrorParams): APIError =>
  createError(ErrorCode.CONFLICT, params);

export const createInternalServerError = (params: ErrorParams): APIError =>
  createError(ErrorCode.INTERNAL_SERVER_ERROR, params);

export const createDatabaseError = (params: ErrorParams): APIError =>
  createError(ErrorCode.DATABASE_ERROR, params);

export const createBadRequestError = (params: ErrorParams): APIError =>
  createError(ErrorCode.BAD_REQUEST, params);

// Type guard for error response
export const isErrorResponse = (error: unknown): error is ErrorResponse => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { code, message, correlationId } = error as ErrorResponse;
  return (
    typeof code === 'string' &&
    typeof message === 'string' &&
    (correlationId === undefined || typeof correlationId === 'string')
  );
};
