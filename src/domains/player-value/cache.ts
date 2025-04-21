import { PlayerValueCache, PlayerValueCacheConfig } from 'domains/player-value/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { PlayerValueRepository } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

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
  repository: PlayerValueRepository,
  config: PlayerValueCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_VALUE,
    ttlSeconds: DefaultTTL.PLAYER_VALUE,
  },
): PlayerValueCache => {
  const { keyPrefix, ttlSeconds } = config;
  const baseKey = `${keyPrefix}`;

  const getPlayerValuesByChangeDate = (
    changeDate: string,
  ): TE.TaskEither<DomainError, SourcePlayerValues> => {
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
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.map(O.fromNullable),
      TE.chain(
        O.fold(
          () =>
            pipe(
              repository.findByChangeDate(changeDate),
              TE.mapLeft(
                mapRepositoryErrorToCacheError('Repository Error: Failed to findByChangeDate'),
              ),
              TE.mapLeft(mapCacheErrorToDomainError),
              TE.chainFirstW((playerValues) =>
                setPlayerValuesByChangeDate(changeDate, playerValues),
              ),
            ),
          (cachedJsonString) =>
            pipe(
              parsePlayerValues(cachedJsonString),
              TE.fromEither,
              TE.mapLeft(mapCacheErrorToDomainError),
            ),
        ),
      ),
      TE.map((playerValues) => (playerValues ? playerValues : [])),
    );
  };

  const setPlayerValuesByChangeDate = (
    changeDate: string,
    playerValues: SourcePlayerValues,
  ): TE.TaskEither<DomainError, void> => {
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
      TE.mapLeft(mapCacheErrorToDomainError),
    );
  };

  return {
    getPlayerValuesByChangeDate,
    setPlayerValuesByChangeDate,
  };
};
