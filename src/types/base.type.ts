import { ValueChangeType } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';

import { APIError, APIErrorCode, CacheError, DBError, createAPIError } from './error.type';

export enum ElementStatus {
  Available = 'a',
  Unavailable = 'u',
  Injured = 'i',
  Suspended = 's',
  NotAvailable = 'n',
  Departed = 'd',
}

export { ValueChangeType };

export enum ElementType {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
  MANAGER = 5,
}

export const ElementTypeConfig = {
  [ElementType.GOALKEEPER]: { id: ElementType.GOALKEEPER, name: 'Goalkeeper' },
  [ElementType.DEFENDER]: { id: ElementType.DEFENDER, name: 'Defender' },
  [ElementType.MIDFIELDER]: { id: ElementType.MIDFIELDER, name: 'Midfielder' },
  [ElementType.FORWARD]: { id: ElementType.FORWARD, name: 'Forward' },
  [ElementType.MANAGER]: { id: ElementType.MANAGER, name: 'Manager' },
} as const;

export const getElementTypeById = (id: number): ElementType | null => {
  switch (id) {
    case ElementType.GOALKEEPER:
      return ElementType.GOALKEEPER;
    case ElementType.DEFENDER:
      return ElementType.DEFENDER;
    case ElementType.MIDFIELDER:
      return ElementType.MIDFIELDER;
    case ElementType.FORWARD:
      return ElementType.FORWARD;
    case ElementType.MANAGER:
      return ElementType.MANAGER;
    default:
      return null;
  }
};

export const getElementTypeName = (type: ElementType): string => ElementTypeConfig[type].name;

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

export interface BaseRepository<T, CreateT, IdT> {
  readonly findAll: () => TE.TaskEither<DBError, T[]>;
  readonly findById: (id: IdT) => TE.TaskEither<DBError, T | null>;
  readonly findByIds: (ids: IdT[]) => TE.TaskEither<DBError, T[]>;
  readonly save: (data: CreateT) => TE.TaskEither<DBError, T>;
  readonly saveBatch: (data: CreateT[]) => TE.TaskEither<DBError, T[]>;
  readonly update: (id: IdT, data: T) => TE.TaskEither<DBError, T>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
  readonly deleteByIds: (ids: IdT[]) => TE.TaskEither<DBError, void>;
}

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

export const isApiResponse = <T extends object, K extends string>(
  data: T,
  snakeCaseKey: K,
): data is T & Record<K, unknown> => snakeCaseKey in data;

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

export const getAllSeasons = (): Season[] => Object.values(Season);
