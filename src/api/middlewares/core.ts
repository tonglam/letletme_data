import { NextFunction, Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';

import {
  APIError,
  APIErrorCode,
  createAPIError,
  getErrorStatus,
  ServiceError,
} from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { AsyncMiddlewareHandler, Middleware, SecurityHeaders } from '../types';
import { sendResponse } from '../utils';

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

const addHeaders =
  (res: Response) =>
  (headers: SecurityHeaders): void => {
    Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  };

export const addSecurityHeaders = (): Middleware => {
  const securityHeaders: SecurityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  } as const;

  return (_req: Request, res: Response, next: NextFunction): void => {
    pipe(securityHeaders, addHeaders(res));
    next();
  };
};

export const handleError = (
  error: Error | APIError | ServiceError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const apiError =
    error instanceof Error && !('code' in error)
      ? toAPIError(error)
      : error.name === 'ServiceError'
        ? toAPIError(error)
        : (error as APIError);
  const status = getErrorStatus(apiError);
  const response = {
    error: {
      code: apiError.code,
      message: apiError.message,
    },
  };
  res.status(status).json(response);
};
