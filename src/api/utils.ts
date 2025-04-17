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

export const formatResponse = <T>(data: T): APIResponseData<T> => ({
  data,
});

export const formatErrorResponse = (message: string): APIErrorResponse => ({
  error: {
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message,
  },
});

const handleError =
  (res: Response) =>
  (error: APIError): void => {
    const status = getErrorStatus(error);
    res.status(status).json(formatErrorResponse(error.message));
  };

const handleSuccess =
  <T>(res: Response) =>
  (data: T): void => {
    res.json(formatResponse(data));
  };

export const sendResponse = <T>(res: Response, result: E.Either<APIError, T>): void => {
  pipe(result, E.fold(handleError(res), handleSuccess(res)));
};

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
