/**
 * Core type definitions and utilities for the application.
 * Includes branded types, base interfaces, and common type utilities.
 */

import { ElementType, ValueChangeType } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { AppConfig } from '../configs/app/app.config';
import { APIError, CacheError, DBError, createValidationError } from './errors.type';

// ============ Constants ============
/**
 * Element status constants for player availability
 */
export const ELEMENT_STATUS = {
  AVAILABLE: 'a',
  UNAVAILABLE: 'u',
  INJURED: 'i',
  DOUBTFUL: 'd',
} as const;

/**
 * Element status type derived from status constants
 */
export type ElementStatus = (typeof ELEMENT_STATUS)[keyof typeof ELEMENT_STATUS];

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
export const validateWithSchema = <T>(
  schema: z.ZodType<T>,
  data: unknown,
  entityName: string,
): E.Either<string, T> => {
  const result = schema.safeParse(data);
  return result.success
    ? E.right(result.data)
    : E.left(`Invalid ${entityName} domain model: ${result.error.message}`);
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
        TE.mapLeft((error) => createValidationError({ message: error.message })),
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
        TE.mapLeft((error) => createValidationError({ message: error.message })),
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
 * Gets current FPL season
 */
export const getCurrentSeason = (): Season =>
  pipe(
    O.fromNullable(AppConfig.currentSeason),
    O.getOrElse(() => getAllSeasons().slice(-1)[0]),
  );

/**
 * Gets all available FPL seasons
 */
export const getAllSeasons = (): Season[] => Object.values(Season);
