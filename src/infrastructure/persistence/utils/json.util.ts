import { DBError, DBErrorCode, createDBError } from '@app/types/error.types';
import { safeParseJson } from '@app/utils/common.util';
import * as E from 'fp-ts/Either';
import { z } from 'zod';

export const parseDbJsonField = <T extends z.ZodTypeAny>(
  schema: T,
  dbValue: string | null | undefined,
  fieldName: string,
): E.Either<DBError, z.infer<T>> => {
  if (dbValue === null || dbValue === undefined) {
    const parseResult = schema.safeParse(dbValue);
    if (parseResult.success) {
      return E.right(parseResult.data);
    } else {
      return E.left(
        createDBError({
          code: DBErrorCode.TRANSFORMATION_ERROR,
          message: `Invalid null/undefined value for field '${fieldName}' according to schema: ${parseResult.error.message}`,
          cause: parseResult.error,
        }),
      );
    }
  }

  const parseJsonResult = safeParseJson(schema)(dbValue);

  if (E.isLeft(parseJsonResult)) {
    const parseError = parseJsonResult.left;
    return E.left(
      createDBError({
        code: DBErrorCode.TRANSFORMATION_ERROR,
        message: `Failed to parse JSON for field '${fieldName}' from DB: ${parseError.message}`,
        cause: parseError,
      }),
    );
  }

  return E.right(parseJsonResult.right);
};
