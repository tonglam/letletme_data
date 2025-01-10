// Service Utility Module
// Utility functions for service layer operations.

import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { ExtendedBootstrapApi } from '../domain/bootstrap/types';
import { FPLEndpoints } from '../infrastructure/http/fpl/types';
import {
  APIErrorCode,
  DomainError,
  ServiceError,
  ServiceErrorCode,
  createAPIError,
  createServiceError,
} from '../types/error.type';

// Converts an Option to a nullable value
export const toNullable = <T>(defaultValue: T) =>
  flow(
    O.fold(
      () => defaultValue,
      (value: T) => value,
    ),
  );

// Converts an Option to a nullable Task
export const toNullableTask = <T>(option: O.Option<T>): T.Task<T | null> =>
  T.of(O.toNullable(option));

// Maps domain errors to service errors
export const mapDomainError = (error: DomainError): ServiceError =>
  createServiceError({
    code: ServiceErrorCode.OPERATION_ERROR,
    message: error.message,
    cause: error as unknown as Error,
  });

export const createBootstrapApiDependencies = (fplClient: FPLEndpoints): ExtendedBootstrapApi => ({
  getBootstrapData: async () => {
    const result = await fplClient.bootstrap.getBootstrapStatic();
    if ('left' in result) {
      throw result.left;
    }
    return result.right;
  },
  getBootstrapEvents: () =>
    pipe(
      TE.tryCatch(
        () => fplClient.bootstrap.getBootstrapStatic(),
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      ),
      TE.chain((result) =>
        'left' in result ? TE.left(result.left) : TE.right(result.right.events),
      ),
    ),
  getBootstrapPhases: () =>
    pipe(
      TE.tryCatch(
        () => fplClient.bootstrap.getBootstrapStatic(),
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      ),
      TE.chain((result) =>
        'left' in result ? TE.left(result.left) : TE.right(result.right.phases),
      ),
    ),
  getBootstrapTeams: () =>
    pipe(
      TE.tryCatch(
        () => fplClient.bootstrap.getBootstrapStatic(),
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      ),
      TE.chain((result) =>
        'left' in result ? TE.left(result.left) : TE.right(result.right.teams),
      ),
    ),
  getBootstrapElements: () =>
    pipe(
      TE.tryCatch(
        () => fplClient.bootstrap.getBootstrapStatic(),
        (error) =>
          createAPIError({
            code: APIErrorCode.INTERNAL_SERVER_ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      ),
      TE.chain((result) =>
        'left' in result ? TE.left(result.left) : TE.right(result.right.elements),
      ),
    ),
});
