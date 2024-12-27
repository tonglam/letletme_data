import { ElementType, PrismaClient, ValueChangeType } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { CacheError, convertTaskEither } from '../infrastructure/cache/types';
import { APIError } from '../infrastructure/http/common/errors';

// ============ Constants ============
export const ELEMENT_STATUS = {
  AVAILABLE: 'a',
  UNAVAILABLE: 'u',
  INJURED: 'i',
  DOUBTFUL: 'd',
} as const;

export type ElementStatus = (typeof ELEMENT_STATUS)[keyof typeof ELEMENT_STATUS];

export { ElementType, ValueChangeType };

export const ElementTypeConfig = {
  [ElementType.GKP]: { id: 1, name: 'Goalkeeper' },
  [ElementType.DEF]: { id: 2, name: 'Defender' },
  [ElementType.MID]: { id: 3, name: 'Midfielder' },
  [ElementType.FWD]: { id: 4, name: 'Forward' },
} as const;

// Derived maps for specific use cases
export const getElementTypeById = (id: number): ElementType | undefined => {
  const entry = Object.entries(ElementTypeConfig).find((entry) => entry[1].id === id);
  return entry ? (entry[0] as ElementType) : undefined;
};

export const getElementTypeName = (type: ElementType): string => ElementTypeConfig[type].name;

// Branded Types System
export interface Brand<K extends string> {
  readonly __brand: K;
}

export type Branded<T, K extends string> = T & Brand<K>;

export const createBrandedType = <T, K extends string>(
  brand: K,
  validator: (value: unknown) => value is T,
) => ({
  validate: (value: unknown): E.Either<string, Branded<T, K>> =>
    validator(value) ? E.right(value as Branded<T, K>) : E.left(`Invalid ${brand}: ${value}`),
  is: (value: unknown): value is Branded<T, K> => validator(value),
});

// Base Repository Interface
export interface BaseRepository<T, TCreate, TId> {
  prisma: PrismaClient;
  findById(id: TId): TE.TaskEither<APIError, T | null>;
  findAll(): TE.TaskEither<APIError, T[]>;
  save(data: Omit<TCreate, 'id'>): TE.TaskEither<APIError, T>;
  saveBatch(data: Omit<TCreate, 'id'>[]): TE.TaskEither<APIError, T[]>;
  update(id: TId, data: Partial<Omit<TCreate, 'id'>>): TE.TaskEither<APIError, T>;
  deleteAll(): TE.TaskEither<APIError, void>;
  findByIds(ids: TId[]): TE.TaskEither<APIError, T[]>;
  deleteByIds(ids: TId[]): TE.TaskEither<APIError, void>;
}

// Schema Validation Helper
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
export const getCachedOrFallbackMany = <T, P>(
  cachedValue: TE.TaskEither<CacheError, readonly P[]> | undefined,
  fallback: TE.TaskEither<APIError, readonly P[]>,
  converter: (items: readonly P[]) => TE.TaskEither<APIError, readonly T[]>,
): TE.TaskEither<APIError, readonly T[]> =>
  cachedValue
    ? pipe(cachedValue, convertTaskEither, TE.chain(converter))
    : pipe(fallback, TE.chain(converter));

export const getCachedOrFallbackOne = <T, P>(
  cachedValue: TE.TaskEither<CacheError, P | null> | undefined,
  fallback: TE.TaskEither<APIError, P | null>,
  converter: (item: P | null) => TE.TaskEither<APIError, T | null>,
): TE.TaskEither<APIError, T | null> =>
  cachedValue
    ? pipe(cachedValue, convertTaskEither, TE.chain(converter))
    : pipe(fallback, TE.chain(converter));

/**
 * Type guard to check if an object is an API response (snake_case) vs domain/persistence model (camelCase)
 */
export const isApiResponse = <T extends object, K extends string>(
  data: T,
  snakeCaseKey: K,
): data is T & Record<K, unknown> => snakeCaseKey in data;
