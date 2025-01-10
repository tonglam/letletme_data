/**
 * Player Value Cache Module
 *
 * Provides caching functionality for player value data using Redis.
 * Implements cache warming, player value retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix, DefaultTTL } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { PlayerValue, PlayerValues } from '../../types/player-value.type';
import { PlayerValueCache, PlayerValueCacheConfig, PlayerValueDataProvider } from './types';

const parsePlayerValue = (playerValueStr: string): E.Either<CacheError, PlayerValues> =>
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
    E.chain((parsed) => {
      if (Array.isArray(parsed)) {
        const validValues = parsed.filter(
          (item): item is PlayerValue =>
            item && typeof item === 'object' && 'id' in item && typeof item.id === 'string',
        );
        return E.right(validValues);
      }
      if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string') {
        return E.right([parsed as PlayerValue]);
      }
      return E.right([]);
    }),
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

  const findByChangeDate = (changeDate: string): TE.TaskEither<CacheError, PlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const cacheKey = `${baseKey}::change_date::${changeDate}`;
          const cachedData = await redisClient.get(cacheKey);

          if (cachedData) {
            return pipe(
              parsePlayerValue(cachedData),
              E.getOrElse<CacheError, PlayerValues>(() => []),
            );
          }

          const playerValues = await dataProvider.getByChangeDate(changeDate);
          if (playerValues.length > 0) {
            await redisClient
              .multi()
              .set(cacheKey, JSON.stringify(playerValues))
              .expire(cacheKey, DefaultTTL.PLAYER_VALUE)
              .exec();
          }
          return playerValues;
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player values by change date from cache',
            cause: error as Error,
          }),
      ),
    );

  return {
    findByChangeDate,
  };
};
