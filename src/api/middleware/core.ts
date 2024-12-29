/**
 * Core Middleware Module
 *
 * Provides essential middleware functions for the API layer including request validation,
 * error handling, security headers, and response formatting. Implements functional
 * programming patterns using fp-ts for robust error handling and type safety.
 *
 * @module api/middleware/core
 * @category API
 */

import { NextFunction, Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import * as t from 'io-ts';
import { PathReporter } from 'io-ts/PathReporter';
import {
  APIError,
  APIErrorCode,
  createAPIError,
  formatErrorResponse,
  getErrorStatus,
} from '../../types/errors.type';
import { AsyncMiddlewareHandler, ErrorHandler, Middleware, SecurityHeaders } from '../types';
import { sendResponse } from '../utils';

/**
 * Converts unknown errors to APIError type
 * @private
 * @param {unknown} error - The error to convert
 * @returns {APIError} Standardized API error
 */
const toAPIError = (error: unknown): APIError =>
  error instanceof Error && 'code' in error
    ? (error as APIError)
    : createAPIError({
        code: APIErrorCode.INTERNAL_SERVER_ERROR,
        message: error instanceof Error ? error.message : 'Internal server error',
        cause: error instanceof Error ? error : undefined,
      });

/**
 * Creates a task that handles API errors by passing them to the next middleware
 * @private
 * @param {NextFunction} next - Express next function
 * @returns {(error: APIError) => T.Task<void>} Error handling task
 */
const handleAPIError =
  (next: NextFunction) =>
  (error: APIError): T.Task<void> => {
    return () => Promise.resolve(next(error));
  };

/**
 * Creates a route handler with standard response formatting and error handling
 * @template T - The type of successful response data
 * @param {AsyncMiddlewareHandler<T>} handler - The async handler function
 * @returns {Middleware} Express middleware function
 */
export const createHandler = <T>(handler: AsyncMiddlewareHandler<T>): Middleware => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await pipe(
      handler(req),
      TE.fold(
        flow(toAPIError, handleAPIError(next)),
        (result) => () => Promise.resolve(sendResponse(res, E.right(result))),
      ),
    )();
  };
};

/**
 * Validates request using io-ts codec
 * @private
 * @template C - The codec type extending t.Mixed
 * @param {C} codec - The io-ts codec to validate against
 * @param {Request} req - Express request object
 * @returns {E.Either<APIError, Request>} Validated request or error
 */
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

/**
 * Creates a validation middleware using io-ts codec
 * @template C - The codec type extending t.Mixed
 * @param {C} codec - The io-ts codec to validate against
 * @returns {Middleware} Express middleware function
 */
export const validateRequest = <C extends t.Mixed>(codec: C): Middleware => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    pipe(
      validateWithCodec(codec, req),
      E.fold(handleAPIError(next), () => T.of(next())),
    )();
  };
};

/**
 * Converts null values to Not Found errors using fp-ts Option
 * @template T - The type of value being checked
 * @param {string} message - The error message if value is null
 * @returns {(value: T | null) => E.Either<APIError, T>} Null checker function
 */
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

/**
 * Security headers configuration
 * @constant
 * @type {SecurityHeaders}
 */
const securityHeaders: SecurityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
} as const;

/**
 * Adds security headers to response
 * @private
 * @param {Response} res - Express response object
 * @returns {(headers: SecurityHeaders) => void} Header setter function
 */
const addHeaders =
  (res: Response) =>
  (headers: SecurityHeaders): void => {
    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  };

/**
 * Security middleware that adds standard security headers
 * @returns {Middleware} Express middleware function
 */
export const addSecurityHeaders = (): Middleware => {
  return (_req: Request, res: Response, next: NextFunction): void => {
    pipe(securityHeaders, addHeaders(res));
    next();
  };
};

/**
 * Global error handler middleware
 * @type {ErrorHandler}
 * @param {Error} error - The error to handle
 * @param {Request} _req - Express request object (unused)
 * @param {Response} res - Express response object
 */
export const handleError: ErrorHandler = (error: Error, _req: Request, res: Response): void => {
  pipe(
    error,
    toAPIError,
    (apiError) => ({
      status: getErrorStatus(apiError),
      response: formatErrorResponse(apiError),
    }),
    ({ status, response }) => res.status(status).json(response),
  );
};
