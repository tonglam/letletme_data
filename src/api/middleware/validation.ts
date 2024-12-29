/**
 * Validation middleware module
 * @module api/middleware/validation
 */

import { NextFunction, Request, Response } from 'express';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { AnyZodObject, ZodError } from 'zod';
import { VALIDATION_CONFIG } from '../../config/api/api.config';
import { formatErrorResponse } from '../responses';

/**
 * Formats ZodError into a string message
 * @param error - Zod validation error
 */
const formatZodError = (error: ZodError): string => error.errors.map((e) => e.message).join(', ');

/**
 * Validates request data against a Zod schema
 * @param request - Express request object
 * @param schema - Zod schema to validate against
 */
const validateRequestData = (request: Request, schema: AnyZodObject) =>
  pipe(
    TE.tryCatch(
      () =>
        schema.parseAsync({
          body: request.body,
          query: request.query,
          params: request.params,
        }),
      E.toError,
    ),
    TE.mapLeft((error) =>
      error instanceof ZodError
        ? { status: VALIDATION_CONFIG.ERROR_CODES.VALIDATION_ERROR, error: formatZodError(error) }
        : {
            status: VALIDATION_CONFIG.ERROR_CODES.SYSTEM_ERROR,
            error: VALIDATION_CONFIG.ERROR_MESSAGES.SYSTEM_ERROR,
          },
    ),
  );

/**
 * Creates a middleware function that validates request data against a Zod schema
 * @param schema - Zod schema to validate the request against
 * @returns Express middleware function that validates request body, query, and params
 */
export const validateRequest = (schema: AnyZodObject) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    pipe(
      validateRequestData(req, schema),
      TE.fold(
        (error) => {
          res.status(error.status).json(formatErrorResponse(error.error));
          return TE.right(undefined);
        },
        () => TE.right(next()),
      ),
    )();
  };
};
