import { NextFunction, Request, Response } from 'express';
import { Either } from 'fp-ts/Either';
import { TaskEither } from 'fp-ts/TaskEither';
import { APIError } from 'src/types/error.type';

export interface APIResponseData<T> {
  readonly data: T;
}

export type AsyncMiddlewareHandler<T> = (req: Request) => TaskEither<APIError, T>;

export type ApiRequest = Request;

export type AsyncHandler<T> = (req: ApiRequest) => Promise<Either<APIError, T>>;

export type AsyncEither<E, A> = Promise<Either<E, A>>;

export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

export interface SecurityHeaders {
  readonly 'X-Content-Type-Options': string;
  readonly 'X-Frame-Options': string;
  readonly 'X-XSS-Protection': string;
  readonly 'Strict-Transport-Security': string;
}
