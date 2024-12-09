import { ErrorCode } from '../config/error-codes';

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export class BaseError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;
  public readonly isOperational: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus: number,
    isOperational = true,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }

  public toJSON(): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      ...(process.env.NODE_ENV === 'development' && { stack: this.stack }),
    };
  }
}

export class ValidationError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, true, details);
  }
}

export class NotFoundError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.NOT_FOUND, message, 404, true, details);
  }
}

export class UnauthorizedError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.UNAUTHORIZED, message, 401, true, details);
  }
}

export class ForbiddenError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.FORBIDDEN, message, 403, true, details);
  }
}

export class ConflictError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.CONFLICT, message, 409, true, details);
  }
}

export class InternalServerError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.INTERNAL_SERVER_ERROR, message, 500, false, details);
  }
}

export class DatabaseError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.DATABASE_ERROR, message, 503, false, details);
  }
}

export class BadRequestError extends BaseError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.BAD_REQUEST, message, 400, true, details);
  }
}

export function isErrorResponse(error: unknown): error is ErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as ErrorResponse).message === 'string'
  );
}
