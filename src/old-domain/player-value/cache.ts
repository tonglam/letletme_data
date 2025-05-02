import { PlayerValueCache, PlayerValueCacheConfig } from 'domain/player-value/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructure/cache/client';
import { PlayerValues } from 'types/domain/player-value.type';
import { CacheError, CacheErrorCode, createCacheError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';

const parsePlayerValues = (playerValuesStr: string): E.Either<CacheError, PlayerValues> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerValuesStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player values JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      Array.isArray(parsed)
        ? E.right(parsed as PlayerValues)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed player values data is not an array',
            }),
          ),
    ),
  );

export const createPlayerValueCache = (
  config: PlayerValueCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_VALUE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.PLAYER_VALUE,
  },
): PlayerValueCache => {
  const { keyPrefix, season, ttlSeconds } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getPlayerValuesByChangeDate = (
    changeDate: string,
  ): TE.TaskEither<CacheError, PlayerValues> => {
    const key = `${baseKey}:${changeDate}`;
    return pipe(
      TE.tryCatch(
        () => redisClient.get(key),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get player values by change date',
            cause: error as Error,
          }),
      ),
      TE.map(O.fromNullable),
      TE.chainW(
        O.fold(
          () => TE.right([] as PlayerValues),
          (cachedJsonString) => pipe(parsePlayerValues(cachedJsonString), TE.fromEither),
        ),
      ),
      TE.map((playerValues) => playerValues ?? []),
    );
  };

  const setPlayerValuesByChangeDate = (
    playerValues: PlayerValues,
  ): TE.TaskEither<CacheError, void> => {
    if (playerValues.length === 0) {
      return TE.right(void 0);
    }
    const changeDate = playerValues[0].changeDate;
    const key = `${baseKey}:${changeDate}`;

    return pipe(
      TE.tryCatch(
        () => redisClient.set(key, JSON.stringify(playerValues), 'EX', ttlSeconds),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set player values by change date',
            cause: error as Error,
          }),
      ),
      TE.map(() => void 0),
    );
  };

  return {
    getPlayerValuesByChangeDate,
    setPlayerValuesByChangeDate,
  };
};
