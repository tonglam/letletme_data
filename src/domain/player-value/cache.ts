/**
 * Player Value Cache Module
 *
 * Provides caching functionality for player value data using Redis.
 * Implements cache warming, player value retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { PlayerValue } from '../../types/player-value.type';
import { PlayerValueCache, PlayerValueCacheConfig, PlayerValueDataProvider } from './types';

const parsePlayerValue = (playerValueStr: string): E.Either<CacheError, PlayerValue | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerValueStr),
      (error: unknown) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player value JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string'
        ? E.right(parsed as PlayerValue)
        : E.right(null),
    ),
  );

const parsePlayerValues = (
  playerValues: Record<string, string>,
): E.Either<CacheError, PlayerValue[]> =>
  pipe(
    Object.values(playerValues),
    (playerValueStrs) =>
      playerValueStrs.map((str) =>
        pipe(
          parsePlayerValue(str),
          E.getOrElse<CacheError, PlayerValue | null>(() => null),
        ),
      ),
    (parsedPlayerValues) =>
      parsedPlayerValues.filter((value): value is PlayerValue => value !== null),
    (validPlayerValues) => E.right(validPlayerValues),
  );

export const createPlayerValueCache = (
  cache: RedisCache<PlayerValue>,
  dataProvider: PlayerValueDataProvider,
  config: PlayerValueCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_VALUE,
    season: getCurrentSeason(),
  },
): PlayerValueCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const playerValues = await dataProvider.getAll();
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          playerValues.forEach((playerValue) => {
            cacheMulti.hset(baseKey, playerValue.id.toString(), JSON.stringify(playerValue));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to warm up cache',
            cause: error as Error,
          }),
      ),
    );

  const cachePlayerValue = (playerValue: PlayerValue): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, playerValue.id.toString(), JSON.stringify(playerValue)),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache player value',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cachePlayerValues = (
    playerValues: readonly PlayerValue[],
  ): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (playerValues.length === 0) return;
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          playerValues.forEach((playerValue) => {
            cacheMulti.hset(baseKey, playerValue.id.toString(), JSON.stringify(playerValue));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache player values',
            cause: error as Error,
          }),
      ),
    );

  const getPlayerValue = (id: string): TE.TaskEither<CacheError, PlayerValue | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player value from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get player value from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((playerValue) =>
                  playerValue ? cachePlayerValue(playerValue) : TE.right(undefined),
                ),
              ),
            (playerValueStr) =>
              pipe(
                parsePlayerValue(playerValueStr),
                TE.fromEither,
                TE.chain((playerValue) =>
                  playerValue
                    ? TE.right(playerValue)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get player value from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((playerValue) =>
                          playerValue ? cachePlayerValue(playerValue) : TE.right(undefined),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllPlayerValues = (): TE.TaskEither<CacheError, readonly PlayerValue[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player values from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error: unknown) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get player values from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chain((playerValues) =>
                  pipe(
                    cachePlayerValues(playerValues),
                    TE.map(() => playerValues),
                  ),
                ),
              ),
            (cachedPlayerValues) =>
              pipe(
                parsePlayerValues(cachedPlayerValues),
                TE.fromEither,
                TE.chain((playerValues) =>
                  playerValues.length > 0
                    ? TE.right(playerValues)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get player values from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chain((playerValues) =>
                          pipe(
                            cachePlayerValues(playerValues),
                            TE.map(() => playerValues),
                          ),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  return {
    warmUp,
    cachePlayerValue,
    cachePlayerValues,
    getPlayerValue,
    getAllPlayerValues,
  };
};
