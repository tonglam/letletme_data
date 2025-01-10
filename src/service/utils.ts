// Service Utility Module
// Utility functions for service layer operations.

import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import { flow } from 'fp-ts/function';
import {
  DomainError,
  ServiceError,
  ServiceErrorCode,
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
