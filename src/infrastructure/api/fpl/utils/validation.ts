import * as E from 'fp-ts/Either';
import { z } from 'zod';
import { APIError, createValidationError } from '../../common/errors';

export const validateResponse =
  <T>(schema: z.ZodSchema<T>) =>
  (data: unknown): E.Either<APIError, T> => {
    const result = schema.safeParse(data);
    return result.success ? E.right(result.data) : E.left(createValidationError(result.error));
  };
