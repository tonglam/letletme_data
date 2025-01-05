// Core Middleware Module
// Provides essential middleware functions for the API layer including request validation,
// error handling, security headers, and response formatting. Implements functional
// programming patterns using fp-ts for robust error handling and type safety.

import { NextFunction, Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import * as t from 'io-ts';
import { PathReporter } from 'io-ts/PathReporter';
import {
  APIError,
  APIErrorCode,
  createAPIError,
  getErrorStatus,
  ServiceError,
} from '../../types/errors.type';
import { AsyncMiddlewareHandler, ErrorHandler, Middleware, SecurityHeaders } from '../types';
import { sendResponse } from '../utils';

// Converts unknown errors to APIError type
const toAPIError = (error: unknown): APIError => {
  if (error instanceof Error) {
    if ('code' in error) {
      if (error.name === 'ServiceError') {
        const serviceError = error as ServiceError;
        return createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: serviceError.message,
          cause: serviceError.cause,
          details: serviceError.details,
        });
      }
      return error as APIError;
    }
  }
  return createAPIError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message: error instanceof Error ? error.message : 'Internal server error',
    cause: error instanceof Error ? error : undefined,
  });
};

// Creates a task that handles API errors by passing them to the next middleware
const handleAPIError =
  (next: NextFunction) =>
  (error: APIError): T.Task<void> => {
    return () => Promise.resolve(next(error));
  };

// Creates a route handler with standard response formatting and error handling
export const createHandler = <T>(handler: AsyncMiddlewareHandler<T>): Middleware => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await pipe(
      handler(req),
      TE.fold(
        (error) => () => Promise.resolve(handleError(error, req, res, next)),
        (result) => () => Promise.resolve(sendResponse(res, E.right(result))),
      ),
    )();
  };
};

// Validates request using io-ts codec
const validateWithCodec = <C extends t.Mixed>(
  codec: C,
  req: Request,
): E.Either<APIError, Request> =>
  pipe(
    codec.decode(req),
    E.mapLeft((errors) =>
      createAPIError({
        code: APIErrorCode.VALIDATION_ERROR,
        message: PathReporter.report(E.left(errors)).join(', '),
      }),
    ),
    E.map(() => req),
  );

// Creates a validation middleware using io-ts codec
export const validateRequest = <C extends t.Mixed>(codec: C): Middleware => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    pipe(
      validateWithCodec(codec, req),
      E.fold(handleAPIError(next), () => T.of(next())),
    )();
  };
};

// Converts null values to Not Found errors using fp-ts Option
export const toNotFoundError =
  <T>(message: string) =>
  (value: T | null): E.Either<APIError, T> =>
    pipe(
      O.fromNullable(value),
      O.fold(
        () =>
          E.left(
            createAPIError({
              code: APIErrorCode.NOT_FOUND,
              message,
            }),
          ),
        E.right,
      ),
    );

// Security headers configuration
const securityHeaders: SecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;

// Adds security headers to response
const addHeaders =
  (res: Response) =>
  (headers: SecurityHeaders): void => {
    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  };

// Security middleware that adds standard security headers
export const addSecurityHeaders = (): Middleware => {
  return (_req: Request, res: Response, next: NextFunction): void => {
    pipe(securityHeaders, addHeaders(res));
    next();
  };
};

// Global error handler middleware
export const handleError: ErrorHandler = (
  error: Error | APIError,
  _req: Request,
  res: Response,
): void => {
  const apiError =
    error instanceof Error && !('code' in error) ? toAPIError(error) : (error as APIError);
  const status = getErrorStatus(apiError);
  const response = {
    error: {
      code: apiError.code,
      message: apiError.message,
    },
  };
  res.status(status).json(response);
};
