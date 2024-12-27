import { CacheTTL } from '@infrastructure/cache/config/cache.config';
import { RedisClient } from '@infrastructure/cache/redis';
import { APIError, createCacheError } from '@infrastructure/errors';
import { PlayerValue } from '@types/playerValues.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createPlayerValuesCache = (redis: RedisClient) => {
  // Key generators
  const createKey = (playerId: number, eventId?: number) =>
    eventId ? `player:${playerId}:values:event:${eventId}` : `player:${playerId}:values:latest`;

  // Cache operations
  const getPlayerValues = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey(playerId, eventId)),
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
    playerId: number,
    eventId: number,
    values: ReadonlyArray<PlayerValue>,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey(playerId, eventId), JSON.stringify(values), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache player values: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  const getLatestPlayerValue = (playerId: number): TE.TaskEither<APIError, PlayerValue> =>
    pipe(
      TE.tryCatch(
        () => redis.get(createKey(playerId)),
        (error) =>
          createCacheError({ message: `Failed to get latest player value from cache: ${error}` }),
      ),
      TE.chain((data) =>
        data
          ? pipe(
              TE.tryCatch(
                () => JSON.parse(data) as PlayerValue,
                (error) => createCacheError({ message: `Invalid cache data: ${error}` }),
              ),
            )
          : TE.left(createCacheError({ message: 'Cache miss' })),
      ),
    );

  const setLatestPlayerValue = (
    playerId: number,
    value: PlayerValue,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redis.set(createKey(playerId), JSON.stringify(value), {
            ttl: CacheTTL.DERIVED_DATA,
          }),
        (error) => createCacheError({ message: `Failed to cache latest player value: ${error}` }),
      ),
      TE.map(() => undefined),
    );

  return {
    getPlayerValues,
    setPlayerValues,
    getLatestPlayerValue,
    setLatestPlayerValue,
  } as const;
};

export type PlayerValuesCache = ReturnType<typeof createPlayerValuesCache>;
