import { CacheError, CacheErrorCode, createCacheError } from '@app/types/error.types';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { ZodError, ZodSchema } from 'zod';

export const parseAndValidateJson = <T>(
  jsonStr: string,
  schema: ZodSchema<T>,
): E.Either<CacheError, T> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(jsonStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse JSON string',
          cause: error instanceof Error ? error : new Error(String(error)),
        }),
    ),
    E.chainW((parsedJson) =>
      pipe(schema.safeParse(parsedJson), (result) =>
        result.success
          ? E.right(result.data)
          : E.left(
              createCacheError({
                code: CacheErrorCode.DESERIALIZATION_ERROR,
                message: 'Parsed JSON failed schema validation',
                details: (result.error as ZodError).format(),
                cause: result.error,
              }),
            ),
      ),
    ),
  );

export const parseJsonMap = <T>(
  jsonMap: Record<string, string>,
  schema: ZodSchema<T>,
): E.Either<CacheError, T[]> =>
  pipe(
    Object.values(jsonMap),
    A.map((str) => parseAndValidateJson(str, schema)),
    E.sequenceArray,
    E.map((items) => [...items]),
  );
