// API Utilities Module
// Provides utility functions for handling API responses, error handling,
// request processing, and common API operations using functional programming
// patterns with fp-ts.

import { Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  APIError,
  APIErrorCode,
  APIErrorResponse,
  createAPIError,
  getErrorStatus,
} from '../types/error.type';
import { logApiError, logApiRequest } from '../utils/logger.util';
import { ApiRequest, APIResponseData, AsyncEither, AsyncHandler } from './types';

// Creates a standard API response wrapper
export const formatResponse = <T>(data: T): APIResponseData<T> => ({
  data,
});

// Creates a standard API error response
export const formatErrorResponse = (message: string): APIErrorResponse => ({
  error: {
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message,
  },
});

// Handles API error responses by formatting and sending the error
const handleError =
  (res: Response) =>
  (error: APIError): void => {
    const status = getErrorStatus(error);
    res.status(status).json(formatErrorResponse(error.message));
  };

// Handles successful API responses by formatting and sending the data
const handleSuccess =
  <T>(res: Response) =>
  (data: T): void => {
    res.json(formatResponse(data));
  };

// Sends a formatted API response handling both success and error cases
export const sendResponse = <T>(res: Response, result: E.Either<APIError, T>): void => {
  pipe(result, E.fold(handleError(res), handleSuccess(res)));
};

// Creates a request handler with standard response formatting and error handling
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
          logApiError(apiReq, error);
          handleError(res)(error);
        },
        (data) => async () => handleSuccess(res)(data),
      ),
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

// Chains two async operations where the second depends on the first
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
