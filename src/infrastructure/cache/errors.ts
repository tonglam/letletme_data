import { BaseError, ErrorDetails } from '@app/shared/types/error.types';
import { ZodError } from 'zod';

export enum CacheErrorCode {
  OPERATION_ERROR = 'CACHE_OPERATION_ERROR',
  CONNECTION_ERROR = 'CACHE_CONNECTION_ERROR',
  NOT_FOUND = 'CACHE_NOT_FOUND',
  SERIALIZATION_ERROR = 'CACHE_SERIALIZATION_ERROR',
  DESERIALIZATION_ERROR = 'CACHE_DESERIALIZATION_ERROR',
}

export interface CacheError extends BaseError {
  readonly _tag: CacheErrorCode;
  readonly name: CacheErrorCode;
  readonly code: string;
}

export const createCacheError = (
  code: CacheErrorCode,
  options: { message: string; cause?: Error; details?: ErrorDetails },
): CacheError => {
  const timestamp = new Date();
  return {
    _tag: code,
    name: code,
    code: code,
    message: options.message,
    cause: options.cause,
    details: options.details,
    timestamp,
  };
};

// Helper to convert ZodError to CacheError
export const zodErrorToCacheError =
  (messagePrefix: string) =>
  (error: ZodError): CacheError =>
    createCacheError(CacheErrorCode.SERIALIZATION_ERROR, {
      message: `${messagePrefix}: Data failed schema validation`,
      details: error.format(),
      cause: error,
    });
