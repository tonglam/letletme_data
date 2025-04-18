import { Response } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

import { APIError, APIErrorCode, APIErrorResponse, getErrorStatus } from '../types/error.type';
import { APIResponseData } from './types';

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
