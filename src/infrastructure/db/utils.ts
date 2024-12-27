import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { APIError, createValidationError } from '../http/common/errors';

/**
 * Converts numeric fields to Prisma.Decimal for data
 * @param data - The data containing numeric fields to convert
 * @param isUpdate - Whether this is for an update operation (uses undefined instead of null)
 * @returns The converted data with Prisma.Decimal fields
 */
export const convertToDecimal = <T extends { [K in keyof T]: unknown }>(
  data: T,
  isUpdate = false,
): T => {
  const nullOrUndefined = isUpdate ? undefined : null;
  const result = { ...data } as { [K in keyof T]: unknown };

  Object.entries(data).forEach(([key, value]) => {
    if (typeof value === 'number') {
      result[key as keyof T] = new Prisma.Decimal(value);
    } else if (value === null || value === undefined) {
      result[key as keyof T] = nullOrUndefined;
    }
  });

  return result as T;
};

/**
 * Converts a value to a Prisma-compatible JSON value for database operations
 * @param value - The value to convert
 * @returns A Prisma-compatible JSON value or JsonNull
 */
export const toNullableJson = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  if (value === null) return Prisma.JsonNull;
  if (typeof value === 'object') return value as Prisma.InputJsonValue;
  return Prisma.JsonNull;
};

/**
 * Parses a JSON value from the database into a typed array
 * @param value - The JSON value from the database
 * @param parser - Function to parse each item in the array
 * @returns Array of parsed items or empty array if invalid
 */
export const parseJsonArray = <T>(
  value: Prisma.JsonValue | null,
  parser: (item: Prisma.JsonObject) => T,
): T[] => {
  if (!value || !Array.isArray(value)) return [];
  return value
    .filter((item): item is Prisma.JsonObject => typeof item === 'object' && item !== null)
    .map(parser);
};

/**
 * Parses a JSON value from the database into a typed object
 * @param value - The JSON value from the database
 * @param parser - Function to parse the object
 * @returns Parsed object or null if invalid
 */
export const parseJsonObject = <T>(
  value: Prisma.JsonValue | null,
  parser: (obj: Prisma.JsonObject) => T | null,
): T | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return parser(value as Prisma.JsonObject);
};

export const ensurePrismaEntity = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<APIError, T> => {
  if (typeof data === 'object' && data !== null && requiredFields.every((field) => field in data)) {
    return E.right(data as T);
  }
  return E.left(
    createValidationError({
      message: `Invalid ${entityName} object`,
      details: {
        missingFields: requiredFields.filter((field) => {
          const obj = data as { [key: string]: unknown } | null;
          return !obj || !(field in obj);
        }),
      },
    }),
  );
};

export const ensurePrismaEntityArray = <T>(
  data: unknown,
  requiredFields: readonly (keyof T)[],
  entityName: string,
): E.Either<APIError, T[]> => {
  if (Array.isArray(data)) {
    const validatedEntities = data.map((item) =>
      ensurePrismaEntity<T>(item, requiredFields, entityName),
    );
    const errors = validatedEntities.filter(E.isLeft).map((e) => e.left);
    if (errors.length > 0) {
      return E.left(
        createValidationError({
          message: `Invalid ${entityName} array`,
          details: { errors },
        }),
      );
    }
    return E.right(validatedEntities.filter(E.isRight).map((p) => p.right));
  }
  return E.left(createValidationError({ message: `Expected array of ${entityName} objects` }));
};
