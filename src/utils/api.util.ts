/**
 * API Utilities Module
 *
 * Provides utility functions for handling API responses, error handling,
 * request processing, and common API operations using functional programming
 * patterns with fp-ts.
 *
 * @module utils/api
 * @category API
 */

import { Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ApiRequest, APIResponseData, AsyncEither, AsyncHandler } from '../types/api.type';
import { APIError, APIErrorCode, APIErrorResponse, createAPIError } from '../types/errors.type';
import { logApiError, logApiRequest } from './logger.util';

/**
 * Creates a standard API response wrapper
 * @template T - The type of data being wrapped
 * @param {T} data - The data to wrap in the response
 * @returns {APIResponseData<T>} Formatted API response
 */
export const formatResponse = <T>(data: T): APIResponseData<T> => ({
  data,
});

/**
 * Creates a standard API error response
 * @param {string} message - The error message
 * @returns {APIErrorResponse} Formatted error response
 */
export const formatErrorResponse = (message: string): APIErrorResponse => ({
  error: message,
});

/**
 * Maps API error codes to HTTP status codes
 * @private
 * @param {APIError} error - The API error to map
 * @returns {number} HTTP status code
 */
const getErrorStatus = (error: APIError): number =>
  error.code === APIErrorCode.NOT_FOUND ? 404 : 500;

/**
 * Handles API error responses by formatting and sending the error
 * @private
 * @param {Response} res - Express response object
 * @returns {(error: APIError) => void} Error handler function
 */
const handleError =
  (res: Response) =>
  (error: APIError): void => {
    const status = getErrorStatus(error);
    res.status(status).json(formatErrorResponse(error.message));
  };

/**
 * Handles successful API responses by formatting and sending the data
 * @private
 * @template T - The type of data being sent
 * @param {Response} res - Express response object
 * @returns {(data: T) => void} Success handler function
 */
const handleSuccess =
  <T>(res: Response) =>
  (data: T): void => {
    res.json(formatResponse(data));
  };

/**
 * Sends a formatted API response handling both success and error cases
 * @template T - The type of successful response data
 * @param {Response} res - Express response object
 * @param {E.Either<APIError, T>} result - The result to send
 */
export const sendResponse = <T>(res: Response, result: E.Either<APIError, T>): void => {
  pipe(result, E.fold(handleError(res), handleSuccess(res)));
};

/**
 * Creates a request handler with standard response formatting and error handling
 * @template T - The type of successful response data
 * @param {string} operation - Name of the operation for logging
 * @param {AsyncHandler<T>} handler - The async handler function
 * @returns {(req: Request, res: Response) => Promise<void>} Express request handler
 */
export const createRequestHandler = <T>(operation: string, handler: AsyncHandler<T>) => {
  return async (req: Request, res: Response): Promise<void> => {
    const apiReq = req as ApiRequest;
    logApiRequest(apiReq, operation);

    await pipe(
      TE.tryCatch(
        () => handler(apiReq),
        (error): APIError =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: 'Unexpected error occurred',
            cause: error as Error,
          }),
      ),
      TE.chain(TE.fromEither),
      TE.fold(
        (error) => async () => {
          logApiError(apiReq, { name: 'APIError', ...error });
          handleError(res)(error);
        },
        (data) => async () => handleSuccess(res)(data),
      ),
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
 * Chains two async operations where the second depends on the first
 * @template T - The type of first operation result
 * @template U - The type of second operation result
 * @param {AsyncEither<APIError, T>} firstOp - First async operation
 * @param {(value: T) => AsyncEither<APIError, U>} secondOp - Second async operation
 * @returns {AsyncEither<APIError, U>} Combined operation result
 */
export const chainOperations = <T, U>(
  firstOp: AsyncEither<APIError, T>,
  secondOp: (value: T) => AsyncEither<APIError, U>,
): AsyncEither<APIError, U> => {
  return pipe(
    TE.tryCatch(
      () => firstOp,
      (error): APIError =>
        createAPIError({
          code: APIErrorCode.INTERNAL_SERVER_ERROR,
          message: 'Operation failed',
          cause: error as Error,
        }),
    ),
    TE.chain(TE.fromEither),
    TE.chain((value) =>
      TE.tryCatch(
        () => secondOp(value),
        (error): APIError =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: 'Operation failed',
            cause: error as Error,
          }),
      ),
    ),
    TE.chain(TE.fromEither),
  )();
};
