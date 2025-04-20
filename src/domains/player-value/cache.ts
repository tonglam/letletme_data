import { PlayerValueCache, PlayerValueCacheConfig } from 'domains/player-value/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { PlayerValueRepository } from 'src/repositories/player-value/type';
import { PlayerValues } from 'src/types/domain/player-value.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { formatYYYYMMDD } from 'src/utils/date.util';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

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
  repository: PlayerValueRepository,
  config: PlayerValueCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_VALUE,
    changeDate: formatYYYYMMDD(),
  },
): PlayerValueCache => {
  const { keyPrefix } = config;
  const baseKey = `${keyPrefix}`;

  const getPlayerValuesByChangeDate = (
    changeDate: string,
  ): TE.TaskEither<DomainError, PlayerValues> =>
    pipe(
      TE.tryCatch(
        () => redisClient.smembers(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get player values by change date',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                repository.findByChangeDate(changeDate),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError(
                    'Repository Error: Failed to get player values by change date on cache miss',
                  ),
                ),
              ),
            (playerValuesStr) => pipe(parsePlayerValues(playerValuesStr), TE.fromEither),
          ),
        ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const setPlayerValuesByChangeDate = (
    changeDate: string,
    playerValues: PlayerValues,
  ): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redisClient.sadd(
            baseKey,
            playerValues.map((value) => value.id),
          ),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set player values by change date',
            cause: error as Error,
          }),
      ),
      TE.map(() => void 0),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getPlayerValuesByChangeDate,
    setPlayerValuesByChangeDate,
  };
};
