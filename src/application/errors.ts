import { BaseError, ErrorDetails } from '@app/shared/types/error.types';

// --- Validation Errors ---
export type ValidationErrorCode = 'VALIDATION_ERROR';

export interface ValidationError extends BaseError {
  readonly _tag: ValidationErrorCode;
  readonly name: ValidationErrorCode;
  readonly code: string;
  readonly details: ErrorDetails; // Validation errors typically require details
}

export const createValidationError = (
  fieldErrors: ErrorDetails,
  message = 'Input validation failed',
): ValidationError => {
  const timestamp = new Date();
  const code = 'VALIDATION_ERROR';
  return {
    _tag: code,
    name: code,
    code: code,
    message,
    details: fieldErrors,
    timestamp,
  };
};

// --- Not Found Errors ---
export type NotFoundErrorCode = 'NOT_FOUND_ERROR';

export interface NotFoundError extends BaseError {
  readonly _tag: NotFoundErrorCode;
  readonly name: NotFoundErrorCode;
  readonly code: string;
  readonly resourceType: string;
  readonly resourceId?: string | number;
}

export const createNotFoundError = (
  resourceType: string,
  resourceId?: string | number,
  message?: string,
  cause?: Error,
): NotFoundError => {
  const timestamp = new Date();
  const code = 'NOT_FOUND_ERROR';
  return {
    _tag: code,
    name: code,
    code: code,
    message: message ?? `${resourceType}${resourceId ? ` [${resourceId}]` : ''} not found.`,
    resourceType,
    resourceId,
    cause,
    timestamp,
  };
};
