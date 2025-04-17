import {
  PlayerValueCache,
  PlayerValueCacheConfig,
  PlayerValueRepository,
} from 'domains/player-value/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { getCurrentSeason } from 'src/types/base.type';
import { PlayerValue, PlayerValueId, PlayerValues } from 'src/types/domain/player-value.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

const parsePlayerValue = (playerValueStr: string): E.Either<CacheError, PlayerValue | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerValueStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player value JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as PlayerValue)
        : E.right(null),
    ),
  );

const parsePlayerValues = (
  playerValuesMap: Record<string, string>,
): E.Either<CacheError, PlayerValue[]> =>
  pipe(
    Object.values(playerValuesMap),
    (playerValueStrs) =>
      playerValueStrs.map((str) =>
        pipe(
          parsePlayerValue(str),
          E.getOrElse<CacheError, PlayerValue | null>(() => null),
        ),
      ),
    (parsedPlayerValues) =>
      parsedPlayerValues.filter((playerValue): playerValue is PlayerValue => playerValue !== null),
    (validPlayerValues) => E.right(validPlayerValues),
  );

export const createPlayerValueCache = (
  repository: PlayerValueRepository,
  config: PlayerValueCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_VALUE,
    season: getCurrentSeason(),
  },
): PlayerValueCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getPlayerValue = (id: PlayerValueId): TE.TaskEither<DomainError, PlayerValue | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id.toString()),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get player value',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                repository.findById(id),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError('Repository Error: Failed to get player value'),
                ),
              ),
            (playerValueStr) => pipe(parsePlayerValue(playerValueStr), TE.fromEither),
          ),
        ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const getAllPlayerValues = (): TE.TaskEither<DomainError, PlayerValues | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all player values',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                repository.findAll(),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError(
                    'Repository Error: Failed to get all player values',
                  ),
                ),
                TE.mapLeft(mapCacheErrorToDomainError),
                TE.chainFirst((playerValues) => setAllPlayerValues(playerValues)),
              ),
            (cachedPlayerValues) =>
              pipe(
                parsePlayerValues(cachedPlayerValues),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
      TE.map((playerValues) => (playerValues.length > 0 ? playerValues : [])),
    );

  const setAllPlayerValues = (playerValues: PlayerValues): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (playerValues.length > 0) {
            const items: Record<string, string> = {};
            playerValues.forEach((playerValue) => {
              items[playerValue.id.toString()] = JSON.stringify(playerValue);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set all player values',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const deleteAllPlayerValues = (): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to delete all player values',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getPlayerValue,
    getAllPlayerValues,
    setAllPlayerValues,
    deleteAllPlayerValues,
  };
};
