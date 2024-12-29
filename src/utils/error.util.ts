// Error utility functions

import * as E from 'fp-ts/Either';
import { APIError, APIErrorCode, createAPIError } from '../types/errors.type';

// Creates a Not Found error with the given message
export const handleNotFound = (message: string): APIError =>
  createAPIError({
    code: APIErrorCode.NOT_FOUND,
    message,
  });

// Handles nullable values by converting them to Either
export const handleNullable =
  <T>(message: string): ((value: T | null) => E.Either<APIError, T>) =>
  (value: T | null) =>
    value === null ? E.left(handleNotFound(message)) : E.right(value);
