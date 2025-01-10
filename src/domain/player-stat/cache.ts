/**
 * Player Stat Cache Module
 *
 * Provides caching functionality for player stat data using Redis.
 * Implements cache warming, player stat retrieval, and batch operations
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
import type { PlayerStat } from '../../types/player-stat.type';
import { PlayerStatCache, PlayerStatCacheConfig, PlayerStatDataProvider } from './types';

const parsePlayerStat = (playerStatStr: string): E.Either<CacheError, PlayerStat | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerStatStr),
      (error: unknown) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player stat JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'string'
        ? E.right(parsed as PlayerStat)
        : E.right(null),
    ),
  );

const parsePlayerStats = (
  playerStats: Record<string, string>,
): E.Either<CacheError, PlayerStat[]> =>
  pipe(
    Object.values(playerStats),
    (playerStatStrs) =>
      playerStatStrs.map((str) =>
        pipe(
          parsePlayerStat(str),
          E.getOrElse<CacheError, PlayerStat | null>(() => null),
        ),
      ),
    (parsedPlayerStats) => parsedPlayerStats.filter((stat): stat is PlayerStat => stat !== null),
    (validPlayerStats) => E.right(validPlayerStats),
  );

export const createPlayerStatCache = (
  cache: RedisCache<PlayerStat>,
  dataProvider: PlayerStatDataProvider,
  config: PlayerStatCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_STAT,
    season: getCurrentSeason(),
  },
): PlayerStatCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const playerStats = await dataProvider.getAll();
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          playerStats.forEach((playerStat) => {
            cacheMulti.hset(baseKey, playerStat.id.toString(), JSON.stringify(playerStat));
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

  const cachePlayerStat = (playerStat: PlayerStat): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, playerStat.id.toString(), JSON.stringify(playerStat)),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache player stat',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cachePlayerStats = (playerStats: readonly PlayerStat[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (playerStats.length === 0) return;
          const multi = redisClient.multi();
          multi.del(baseKey);
          await multi.exec();
          const cacheMulti = redisClient.multi();
          playerStats.forEach((playerStat) => {
            cacheMulti.hset(baseKey, playerStat.id.toString(), JSON.stringify(playerStat));
          });
          await cacheMulti.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache player stats',
            cause: error as Error,
          }),
      ),
    );

  const getPlayerStat = (id: string): TE.TaskEither<CacheError, PlayerStat | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player stat from cache',
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
                      message: 'Failed to get player stat from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((playerStat) =>
                  playerStat ? cachePlayerStat(playerStat) : TE.right(undefined),
                ),
              ),
            (playerStatStr) =>
              pipe(
                parsePlayerStat(playerStatStr),
                TE.fromEither,
                TE.chain((playerStat) =>
                  playerStat
                    ? TE.right(playerStat)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get player stat from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((playerStat) =>
                          playerStat ? cachePlayerStat(playerStat) : TE.right(undefined),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllPlayerStats = (): TE.TaskEither<CacheError, readonly PlayerStat[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player stats from cache',
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
                      message: 'Failed to get player stats from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chain((playerStats) =>
                  pipe(
                    cachePlayerStats(playerStats),
                    TE.map(() => playerStats),
                  ),
                ),
              ),
            (cachedPlayerStats) =>
              pipe(
                parsePlayerStats(cachedPlayerStats),
                TE.fromEither,
                TE.chain((playerStats) =>
                  playerStats.length > 0
                    ? TE.right(playerStats)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get player stats from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chain((playerStats) =>
                          pipe(
                            cachePlayerStats(playerStats),
                            TE.map(() => playerStats),
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
    cachePlayerStat,
    cachePlayerStats,
    getPlayerStat,
    getAllPlayerStats,
  };
};
