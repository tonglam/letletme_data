/**
 * Player Cache Module
 *
 * Provides caching functionality for player data using Redis.
 * Implements cache warming, player retrieval, and batch operations
 * with proper type safety and error handling.
 */

import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { Player } from '../../types/player.type';
import { PlayerCache, PlayerCacheConfig, PlayerDataProvider } from '../../types/player/types';

const parsePlayer = (playerStr: string): E.Either<CacheError, Player | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerStr),
      (error: unknown) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Player)
        : E.right(null),
    ),
  );

const parsePlayers = (players: Record<string, string>): E.Either<CacheError, Player[]> =>
  pipe(
    Object.values(players),
    (playerStrs) =>
      playerStrs.map((str) =>
        pipe(
          parsePlayer(str),
          E.getOrElse<CacheError, Player | null>(() => null),
        ),
      ),
    (parsedPlayers) => parsedPlayers.filter((player): player is Player => player !== null),
    (validPlayers) => E.right(validPlayers),
  );

export const createPlayerCache = (
  cache: RedisCache<Player>,
  dataProvider: PlayerDataProvider,
  config: PlayerCacheConfig = {
    keyPrefix: CachePrefix.PLAYER,
    season: getCurrentSeason(),
  },
): PlayerCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const players = await dataProvider.getAll();
          if (players.length === 0) return;

          await cache.client.del(baseKey);
          const multi = cache.client.multi();
          players.forEach((player) => {
            multi.hset(baseKey, player.id.toString(), JSON.stringify(player));
          });
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to warm up cache',
            cause: error as Error,
          }),
      ),
    );

  const cachePlayer = (player: Player): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.client.hset(baseKey, player.id.toString(), JSON.stringify(player)),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache player',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cachePlayers = (players: readonly Player[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (players.length === 0) return;

          await cache.client.del(baseKey);
          const multi = cache.client.multi();
          players.forEach((player) => {
            multi.hset(baseKey, player.id.toString(), JSON.stringify(player));
          });
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache players',
            cause: error as Error,
          }),
      ),
    );

  const getPlayer = (id: string): TE.TaskEither<CacheError, Player | null> =>
    pipe(
      TE.tryCatch(
        () => cache.client.hget(baseKey, id),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get player from cache',
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
                      message: 'Failed to get player from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((player) => (player ? cachePlayer(player) : TE.right(undefined))),
              ),
            (playerStr) =>
              pipe(
                parsePlayer(playerStr),
                TE.fromEither,
                TE.chain((player) =>
                  player
                    ? TE.right(player)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get player from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((player) =>
                          player ? cachePlayer(player) : TE.right(undefined),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllPlayers = (): TE.TaskEither<CacheError, readonly Player[]> =>
    pipe(
      TE.tryCatch(
        () => cache.client.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get players from cache',
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
                      message: 'Failed to get players from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chain((players) =>
                  pipe(
                    cachePlayers(players),
                    TE.map(() => players),
                  ),
                ),
              ),
            (cachedPlayers) =>
              pipe(
                parsePlayers(cachedPlayers),
                TE.fromEither,
                TE.chain((players) =>
                  players.length > 0
                    ? TE.right(players)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error: unknown) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get players from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chain((players) =>
                          pipe(
                            cachePlayers(players),
                            TE.map(() => players),
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
    cachePlayer,
    cachePlayers,
    getPlayer,
    getAllPlayers,
  };
};
