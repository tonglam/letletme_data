import { CacheTTL } from '@infrastructure/cache/config/cache.config';
import { RedisClient } from '@infrastructure/cache/redis';
import { APIError, createCacheError } from '@infrastructure/errors';
import { PlayerStat } from '@types/playerStats.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createPlayerStatsCache = (redis: RedisClient) => {
  // Key generators
  const createKey = (playerId: number, eventId?: number) =>
    eventId ? `player:${playerId}:stats:event:${eventId}` : `player:${playerId}:stats:latest`;

  // Cache operations
  const getPlayerStats = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey(playerId, eventId)),
        (error) => createCacheError({ message: `Failed to get player stats from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as ReadonlyArray<PlayerStat>,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setPlayerStats = (
    playerId: number,
    eventId: number,
    stats: ReadonlyArray<PlayerStat>,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey(playerId, eventId), JSON.stringify(stats), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const getLatestPlayerStats = (playerId: number): TE.TaskEither<APIError, PlayerStat> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey(playerId)),
        (error) =>
          createCacheError({ message: `Failed to get latest player stats from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as PlayerStat,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setLatestPlayerStats = (
    playerId: number,
    stats: PlayerStat,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey(playerId), JSON.stringify(stats), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache latest player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  return {
    getPlayerStats,
    setPlayerStats,
    getLatestPlayerStats,
    setLatestPlayerStats,
  } as const;
};

export type PlayerStatsCache = ReturnType<typeof createPlayerStatsCache>;
