// Prisma Utility Module
// Utility functions for Prisma data transformations and validations.
// Implements type-safe data handling with fp-ts patterns.

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { APIErrorCode, DBError, DBErrorCode } from '../types/errors.type';
import { createDatabaseValidationError } from './error.util';

// ============ Prisma Data Transformations ============

// Converts numeric fields to Prisma.Decimal
// Transforms numeric values in an object to Prisma-compatible decimal format
export const convertToDecimal = <T extends Record<string, unknown>>(
  data: T,
  isUpdate = false,
): { [K in keyof T]: T[K] | Prisma.Decimal | null | undefined } => {
  const result = { ...data };
  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === 'number') {
      (result as Record<string, unknown>)[key] = new Prisma.Decimal(value);
    } else if (value === null || value === undefined) {
      (result as Record<string, unknown>)[key] = isUpdate ? undefined : null;
    }
  });
  return result as { [K in keyof T]: T[K] | Prisma.Decimal | null | undefined };
};

// Converts a value to Prisma-compatible JSON
// Transforms values to Prisma JSON format with null handling
export const toNullableJson = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput =>
  pipe(
    value,
    O.fromNullable,
    O.fold(
      () => Prisma.JsonNull,
      (v) => (typeof v === 'object' ? (v as Prisma.InputJsonValue) : Prisma.JsonNull),
    ),
  );

// Parses a JSON array into typed objects
// Safely transforms JSON array into typed objects with validation
export const parseJsonArray = <T>(
  value: Prisma.JsonValue | null,
  parser: (item: Prisma.JsonObject) => T,
): T[] =>
  pipe(
    value,
    O.fromNullable,
    O.chain((v) => (Array.isArray(v) ? O.some(v) : O.none)),
    O.fold(
      () => [],
      (arr) =>
        arr
          .filter((item): item is Prisma.JsonObject => typeof item === 'object' && item !== null)
          .map(parser),
    ),
  );

// Parses a JSON object into a typed object
// Safely transforms JSON object with validation
export const parseJsonObject = <T>(
  value: Prisma.JsonValue | null,
  parser: (obj: Prisma.JsonObject) => T | null,
): T | null =>
  pipe(
    value,
    O.fromNullable,
    O.chain((v) =>
      typeof v === 'object' && !Array.isArray(v) ? O.some(v as Prisma.JsonObject) : O.none,
    ),
    O.fold(() => null, parser),
  );

/**
 * Validates a Prisma entity
 * Ensures required fields are present in the entity
 */
export const ensurePrismaEntity = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<DBError, T> =>
  pipe(
    data,
    O.fromPredicate(
      (d): d is object =>
        typeof d === 'object' && d !== null && requiredFields.every((f) => f in d),
    ),
    E.fromOption(() => {
      const missingFields = pipe(
        data,
        O.fromNullable,
        O.fold(
          () => requiredFields,
          (d) => requiredFields.filter((f) => !(f in d)),
        ),
      );
      return createDatabaseValidationError({
        message: `Invalid ${entityName} object`,
        details: { missingFields },
      });
    }),
    E.map((d) => d as T),
  );

/**
 * Validates an array of Prisma entities
 * Ensures all items in array are valid entities
 */
export const ensurePrismaEntityArray = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<DBError, T[]> =>
  pipe(
    data,
    O.fromPredicate(Array.isArray),
    E.fromOption(() =>
      createDatabaseValidationError({
        message: `Expected array of ${entityName} objects`,
      }),
    ),
    E.chain((arr) =>
      pipe(
        arr,
        E.traverseArray((item) => ensurePrismaEntity<T>(item, requiredFields, entityName)),
        E.map((items) => [...items]),
        E.mapLeft((errors) =>
          createDatabaseValidationError({
            message: `Invalid ${entityName} array`,
            details: { errors },
          }),
        ),
      ),
    ),
  );

// ============ Database Error Handling ============

/**
 * Maps database error codes to API error codes
 */
export const dbErrorToApiErrorCode: Record<DBErrorCode, APIErrorCode> = {
  [DBErrorCode.CONNECTION_ERROR]: APIErrorCode.SERVICE_ERROR,
  [DBErrorCode.OPERATION_ERROR]: APIErrorCode.INTERNAL_SERVER_ERROR,
  [DBErrorCode.VALIDATION_ERROR]: APIErrorCode.VALIDATION_ERROR,
  [DBErrorCode.TRANSFORMATION_ERROR]: APIErrorCode.BAD_REQUEST,
};

/**
 * Type guard for DBError
 */
export const isDBError = (error: unknown): error is DBError =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  Object.values(DBErrorCode).includes((error as DBError).code);

type TransformedType<T, K extends keyof T> = Omit<T, K> &
  Record<K, Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined>;

/**
 * Transforms JSON fields in a domain model to Prisma-compatible nullable JSON format
 * @param data The domain model data
 * @param jsonFields Array of field names that should be transformed to nullable JSON
 * @returns A new object with transformed JSON fields
 */
export const transformJsonFields = <T extends object, K extends keyof T>(
  data: T,
  jsonFields: K[],
): TransformedType<T, K> =>
  ({
    ...data,
    ...Object.fromEntries(
      jsonFields.map((field) => [
        field,
        data[field] ? (data[field] as Prisma.InputJsonValue) : Prisma.JsonNull,
      ]),
    ),
  }) as TransformedType<T, K>;
