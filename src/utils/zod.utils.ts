import * as E from 'fp-ts/Either';
import { z, ZodError } from 'zod';

export const safeParseResultToEither = <I, O>(
  result: z.SafeParseReturnType<I, O>,
): E.Either<ZodError<I>, O> => {
  if (result.success) {
    return E.right(result.data);
  }
  return E.left(result.error);
};
