import { PlayerValueCache, PlayerValueCacheConfig } from 'domains/player-value/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { formatYYYYMMDD } from 'src/utils/date.util';
import { mapCacheErrorToDomainError } from 'src/utils/error.util';

const parsePlayerValues = (playerValuesStr: string): E.Either<CacheError, SourcePlayerValues> =>
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
        ? E.right(parsed as SourcePlayerValues)
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
    changeDate: formatYYYYMMDD(),
  },
): PlayerValueCache => {
  const { keyPrefix } = config;
  const baseKey = `${keyPrefix}`;

  const getPlayerValuesByChangeDate = (): TE.TaskEither<DomainError, SourcePlayerValues> =>
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
      TE.chain((playerValuesStrArray) =>
        pipe(
          O.fromNullable(playerValuesStrArray),
          O.fold(
            () =>
              TE.left(
                createCacheError({
                  code: CacheErrorCode.NOT_FOUND,
                  message: 'Cache Miss: No player values found for the given change date',
                }),
              ),
            (values) => pipe(`[${values.join(',')}]`, parsePlayerValues, TE.fromEither),
          ),
        ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const setPlayerValuesByChangeDate = (
    playerValues: SourcePlayerValues,
  ): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redisClient.sadd(
            baseKey,
            playerValues.map((value) => JSON.stringify(value)),
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
