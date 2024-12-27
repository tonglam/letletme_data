import { CacheTTL } from '@infrastructure/cache/config/cache.config';
import { RedisClient } from '@infrastructure/cache/redis';
import { APIError, createCacheError } from '@infrastructure/errors';
import { Player, PlayerStat, PlayerValue } from '@types/players.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createPlayerCache = (redis: RedisClient) => {
  // Key generators
  const createKey = (type: 'all' | 'player' | 'values' | 'stats', id?: number) =>
    id ? `players:${type}:${id}` : `players:${type}`;

  // Core player cache operations
  const getPlayers = (): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey('all')),
        (error) => createCacheError({ message: `Failed to get players from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as ReadonlyArray<Player>,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setPlayers = (players: ReadonlyArray<Player>): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => redis.set(createKey('all'), JSON.stringify(players), { ttl: CacheTTL.METADATA }),
        (error) => createCacheError({ message: `Failed to cache players: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const getPlayer = (id: number): TE.TaskEither<APIError, Player> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey('player', id)),
        (error) => createCacheError({ message: `Failed to get player from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as Player,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setPlayer = (id: number, player: Player): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey('player', id), JSON.stringify(player), {
            ttl: CacheTTL.METADATA,
          }),
        (error) => createCacheError({ message: `Failed to cache player: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  // Player values cache operations
  const getPlayerValues = (id: number): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey('values', id)),
        (error) =>
          createCacheError({ message: `Failed to get player values from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as ReadonlyArray<PlayerValue>,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setPlayerValues = (
    id: number,
    values: ReadonlyArray<PlayerValue>,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey('values', id), JSON.stringify(values), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache player values: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  // Player stats cache operations
  const getPlayerStats = (id: number): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey('stats', id)),
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
    id: number,
    stats: ReadonlyArray<PlayerStat>,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey('stats', id), JSON.stringify(stats), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache player stats: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  return {
    getPlayers,
    setPlayers,
    getPlayer,
    setPlayer,
    getPlayerValues,
    setPlayerValues,
    getPlayerStats,
    setPlayerStats,
  } as const;
};

export type PlayerCache = ReturnType<typeof createPlayerCache>;
