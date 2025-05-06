import { createDBError, DBError, DBErrorCode } from '@app/types/error.types';
import { getErrorMessage } from '@app/utils/error.util';
import { ZodError } from 'zod';

export const formatZodErrorForDbError =
  (context: string) =>
  (error: ZodError): DBError => {
    const messages = error.errors.map((e) => e.message).join(', ');
    return createDBError({
      code: DBErrorCode.TRANSFORMATION_ERROR,
      message: `Validation failed during DB mapping for ${context}: ${messages}`,
      cause: error,
    });
  };

export const mapErrorToDbError = (
  error: Error,
  defaultCode: DBErrorCode = DBErrorCode.OPERATION_ERROR,
  context?: string,
): DBError =>
  createDBError({
    code: defaultCode,
    message: `${context ? context + ': ' : ''}${getErrorMessage(error)}`,
    cause: error,
  });
