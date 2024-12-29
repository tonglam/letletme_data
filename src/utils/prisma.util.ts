/**
 * Prisma Utility Module
 *
 * Utility functions for Prisma data transformations and validations.
 * Implements type-safe data handling with fp-ts patterns.
 */

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';
import { APIError, createValidationError } from '../types/errors.type';

/**
 * Converts numeric fields to Prisma.Decimal
 * Transforms numeric values in an object to Prisma-compatible decimal format
 *
 * @param data - Object containing numeric fields
 * @param isUpdate - Whether the conversion is for an update operation
 * @returns Transformed object with Prisma.Decimal values
 */
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

/**
 * Converts a value to Prisma-compatible JSON
 * Transforms values to Prisma JSON format with null handling
 *
 * @param value - Value to convert to JSON
 * @returns Prisma-compatible JSON value
 */
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

/**
 * Parses a JSON array into typed objects
 * Safely transforms JSON array into typed objects with validation
 *
 * @param value - JSON array to parse
 * @param parser - Function to parse individual items
 * @returns Array of parsed objects
 */
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

/**
 * Parses a JSON object into a typed object
 * Safely transforms JSON object with validation
 *
 * @param value - JSON object to parse
 * @param parser - Function to parse the object
 * @returns Parsed object or null
 */
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
 *
 * @param data - Entity to validate
 * @param requiredFields - Array of required field keys
 * @param entityName - Name of the entity for error messages
 * @returns Either with validated entity or validation error
 */
export const ensurePrismaEntity = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<APIError, T> =>
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
      return createValidationError({
        message: `Invalid ${entityName} object`,
        details: { missingFields },
      });
    }),
    E.map((d) => d as T),
  );

/**
 * Validates an array of Prisma entities
 * Ensures all items in array are valid entities
 *
 * @param data - Array of entities to validate
 * @param requiredFields - Array of required field keys
 * @param entityName - Name of the entity for error messages
 * @returns Either with validated array or validation error
 */
export const ensurePrismaEntityArray = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<APIError, T[]> =>
  pipe(
    data,
    O.fromPredicate(Array.isArray),
    E.fromOption(() =>
      createValidationError({ message: `Expected array of ${entityName} objects` }),
    ),
    E.chain((arr) =>
      pipe(
        arr,
        E.traverseArray((item) => ensurePrismaEntity<T>(item, requiredFields, entityName)),
        E.map((items) => [...items]),
        E.mapLeft((errors) =>
          createValidationError({
            message: `Invalid ${entityName} array`,
            details: { errors },
          }),
        ),
      ),
    ),
  );
