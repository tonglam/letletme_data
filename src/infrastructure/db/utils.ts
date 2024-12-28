/**
 * Database Utilities Module
 *
 * Provides utility functions for database operations and data transformation.
 * Implements common patterns for data handling and validation.
 *
 * Features:
 * - Data type conversion utilities
 * - JSON handling functions
 * - Entity validation
 * - Error handling
 * - Type-safe transformations
 *
 * This module provides reusable utilities for implementing
 * database operations and handling common data scenarios.
 */

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { APIError, createValidationError } from '../http/common/errors';

/**
 * Converts numeric fields to Prisma.Decimal for database operations.
 * Handles null/undefined values based on operation type.
 *
 * @param data - The data containing numeric fields to convert
 * @param isUpdate - Whether this is for an update operation
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
 * Converts a value to a Prisma-compatible JSON value.
 * Handles null values and complex objects.
 *
 * @param value - The value to convert to JSON
 * @returns Prisma-compatible JSON value or JsonNull
 */
export const toNullableJson = (
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  if (value === null) return Prisma.JsonNull;
  if (typeof value === 'object') return value as Prisma.InputJsonValue;
  return Prisma.JsonNull;
};

/**
 * Parses a JSON array from the database into typed objects.
 * Handles validation and type conversion.
 *
 * @template T - The type of items in the array
 * @param value - The JSON value from the database
 * @param parser - Function to parse each item
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
 * Parses a JSON object from the database into a typed object.
 * Handles validation and type conversion.
 *
 * @template T - The type of the resulting object
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

/**
 * Validates a Prisma entity against required fields.
 * Ensures data integrity before database operations.
 *
 * @template T - The type of the entity
 * @param data - The data to validate
 * @param requiredFields - Array of required field keys
 * @param entityName - Name of the entity for error messages
 * @returns Either with validated entity or validation error
 */
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

/**
 * Validates an array of Prisma entities.
 * Ensures data integrity for batch operations.
 *
 * @template T - The type of the entities
 * @param data - The array of data to validate
 * @param requiredFields - Array of required field keys
 * @param entityName - Name of the entity for error messages
 * @returns Either with validated entities or validation error
 */
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
