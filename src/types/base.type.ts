/**
 * Core type definitions and utilities for the application.
 * Includes branded types, base interfaces, and common type utilities.
 */

import { ElementType, ValueChangeType } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { APIError, APIErrorCode, CacheError, DBError, createAPIError } from './error.type';

// ============ Constants ============
/**
 * Element status constants for player availability
 */
export enum ElementStatus {
  Available = 'a',
  Unavailable = 'u',
  Injured = 'i',
  Suspended = 's',
  NotAvailable = 'n',
  Departed = 'd',
}

export { ElementType, ValueChangeType };

/**
 * Configuration for element types with their IDs and names
 */
export const ElementTypeConfig = {
  [ElementType.GKP]: { id: 1, name: 'Goalkeeper' },
  [ElementType.DEF]: { id: 2, name: 'Defender' },
  [ElementType.MID]: { id: 3, name: 'Midfielder' },
  [ElementType.FWD]: { id: 4, name: 'Forward' },
} as const;

// Derived maps for specific use cases
/**
 * Gets element type by its numeric ID
 */
export const getElementTypeById = (id: number): ElementType | undefined => {
  const entry = Object.entries(ElementTypeConfig).find((entry) => entry[1].id === id);
  return entry ? (entry[0] as ElementType) : undefined;
};

/**
 * Gets element type display name
 */
export const getElementTypeName = (type: ElementType): string => ElementTypeConfig[type].name;

// Branded Types System
/**
 * Brand interface for type branding
 */
export interface Brand<K extends string> {
  readonly __brand: K;
}

/**
 * Branded type combining a base type with a brand
 */
export type Branded<T, K extends string> = T & Brand<K>;

/**
 * Creates a branded type with validation
 */
export const createBrandedType = <T, K extends string>(
  brand: K,
  validator: (value: unknown) => value is T,
) => ({
  validate: (value: unknown): E.Either<string, Branded<T, K>> =>
    validator(value) ? E.right(value as Branded<T, K>) : E.left(`Invalid ${brand}: ${value}`),
  is: (value: unknown): value is Branded<T, K> => validator(value),
});

// Base Repository Interface
/**
 * Base repository interface
 * All repository operations return DBError for database-related errors
 */
export interface BaseRepository<T, CreateT, IdT> {
  readonly findAll: () => TE.TaskEither<DBError, T[]>;
  readonly findById: (id: IdT) => TE.TaskEither<DBError, T | null>;
  readonly save: (data: CreateT) => TE.TaskEither<DBError, T>;
  readonly saveBatch: (data: CreateT[]) => TE.TaskEither<DBError, T[]>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
  readonly deleteByIds: (ids: IdT[]) => TE.TaskEither<DBError, void>;
}

// Schema Validation Helper
/**
 * Validates data against a Zod schema
 */
export const validateSchema =
  <T>(schema: z.Schema<T>, entityName: string) =>
  (data: unknown): E.Either<string, T> => {
    const result = schema.safeParse(data);
    if (result.success) {
      return E.right(result.data);
    }
    const error = result as z.SafeParseError<T>;
    return E.left(
      `Invalid ${entityName} domain model: ${error.error.errors[0]?.message || 'Unknown error'}`,
    );
  };

// Common Cache Handlers
/**
 * Gets cached data or falls back to fetching many items
 */
export const getCachedOrFallbackMany = <T, P>(
  cachedValue: TE.TaskEither<CacheError, readonly P[]> | undefined,
  fallback: TE.TaskEither<APIError, readonly P[]>,
  converter: (items: readonly P[]) => TE.TaskEither<APIError, readonly T[]>,
): TE.TaskEither<APIError, readonly T[]> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error: CacheError) =>
          createAPIError({
            code: APIErrorCode.SERVICE_ERROR,
            message: error.message,
          }),
        ),
        TE.chain(converter),
      )
    : pipe(fallback, TE.chain(converter));

/**
 * Gets cached data or falls back to fetching a single item
 */
export const getCachedOrFallbackOne = <T, P>(
  cachedValue: TE.TaskEither<CacheError, P | null> | undefined,
  fallback: TE.TaskEither<APIError, P | null>,
  converter: (item: P | null) => TE.TaskEither<APIError, T | null>,
): TE.TaskEither<APIError, T | null> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error: CacheError) =>
          createAPIError({
            code: APIErrorCode.SERVICE_ERROR,
            message: error.message,
          }),
        ),
        TE.chain(converter),
      )
    : pipe(fallback, TE.chain(converter));

/**
 * Type guard for API responses
 */
export const isApiResponse = <T extends object, K extends string>(
  data: T,
  snakeCaseKey: K,
): data is T & Record<K, unknown> => snakeCaseKey in data;

/**
 * FPL season enumeration
 */
export enum Season {
  Season_1617 = '1617',
  Season_1718 = '1718',
  Season_1819 = '1819',
  Season_1920 = '1920',
  Season_2021 = '2021',
  Season_2122 = '2122',
  Season_2223 = '2223',
  Season_2324 = '2324',
  Season_2425 = '2425',
}

/**
 * Gets current FPL season in format 'YYZZ' (e.g., '2324' for 2023/24 season)
 * For example:
 * - August 2023 to July 2024 returns '2324'
 * - August 2024 to July 2025 returns '2425'
 */
export const getCurrentSeason = (): string => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  const startYear = currentMonth >= 8 ? currentYear : currentYear - 1;
  const endYear = startYear + 1;
  const startYearStr = startYear.toString().slice(-2);
  const endYearStr = endYear.toString().slice(-2);
  return `${startYearStr}${endYearStr}`;
};

/**
 * Gets all available FPL seasons
 */
export const getAllSeasons = (): Season[] => Object.values(Season);
