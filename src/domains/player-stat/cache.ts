import { PlayerStatCache, PlayerStatCacheConfig } from 'domains/player-stat/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { getCurrentSeason } from 'src/utils/common.util';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

const parsePlayerStat = (playerStatStr: string): E.Either<CacheError, PlayerStat> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(playerStatStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse player stat JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as PlayerStat)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid PlayerStat structure',
            }),
          ),
    ),
  );

const parsePlayerStats = (
  playerStatsMap: Record<string, string>,
): E.Either<CacheError, PlayerStat[]> =>
  pipe(
    Object.values(playerStatsMap),
    (playerStatStrs) =>
      playerStatStrs.map((str) =>
        pipe(
          parsePlayerStat(str),
          E.getOrElse<CacheError, PlayerStat | null>(() => null),
        ),
      ),
    (parsedPlayerStats) =>
      parsedPlayerStats.filter((playerStat): playerStat is PlayerStat => playerStat !== null),
    (validPlayerStats) => E.right(validPlayerStats),
  );

export const createPlayerStatCache = (
  repository: PlayerStatRepository,
  config: PlayerStatCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_STAT,
    season: getCurrentSeason(),
  },
): PlayerStatCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getAllPlayerStats = (): TE.TaskEither<DomainError, PlayerStats> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all player stats',
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
                    'Repository Error: Failed to get all player stats',
                  ),
                ),
                TE.mapLeft(mapCacheErrorToDomainError),
                TE.chainFirst((playerStats) => setAllPlayerStats(playerStats)),
              ),
            (cachedPlayerStats) =>
              pipe(
                parsePlayerStats(cachedPlayerStats),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
      TE.map((playerStats) => (playerStats.length > 0 ? playerStats : [])),
    );

  const setAllPlayerStats = (playerStats: PlayerStats): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (playerStats.length > 0) {
            const items: Record<string, string> = {};
            playerStats.forEach((playerStat) => {
              items[playerStat.element.toString()] = JSON.stringify(playerStat);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set all player stats',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const deleteAllPlayerStats = (): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to delete all player stats',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getAllPlayerStats,
    setAllPlayerStats,
    deleteAllPlayerStats,
  };
};
