import { PlayerStatCache, PlayerStatCacheConfig } from 'domains/player-stat/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { getCurrentSeason } from 'src/utils/common.util';
import { mapCacheErrorToDomainError } from 'src/utils/error.util';

const DECIMAL_FIELDS_AS_STRINGS: ReadonlyArray<keyof PlayerStat> = [
  'expectedGoals',
  'expectedAssists',
  'expectedGoalInvolvements',
  'expectedGoalsConceded',
];

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
    E.chain((parsed: Record<string, unknown>) => {
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('element' in parsed) ||
        typeof parsed.element !== 'number'
      ) {
        return E.left(
          createCacheError({
            code: CacheErrorCode.DESERIALIZATION_ERROR,
            message:
              'Parsed object is not a valid PlayerStat structure (missing or invalid element field)',
          }),
        );
      }

      DECIMAL_FIELDS_AS_STRINGS.forEach((field) => {
        const value = parsed[field];
        if (typeof value === 'string') {
          const num = parseFloat(value);
          parsed[field] = isNaN(num) ? null : num;
        } else if (value !== null && typeof value !== 'number') {
          parsed[field] = null;
        }
      });

      return E.right(parsed as unknown as PlayerStat);
    }),
  );

const parsePlayerStats = (
  playerStatsMap: Record<string, string>,
): E.Either<CacheError, PlayerStats> =>
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
  config: PlayerStatCacheConfig = {
    keyPrefix: CachePrefix.PLAYER_STAT,
    season: getCurrentSeason(),
  },
): PlayerStatCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getLatestPlayerStats = (): TE.TaskEither<DomainError, PlayerStats> =>
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
      TE.chainW(
        flow(
          O.fromNullable,
          O.match(
            () => TE.right([] as PlayerStats),
            (cachedPlayerStats) =>
              pipe(
                parsePlayerStats(cachedPlayerStats),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setLatestPlayerStats = (playerStats: PlayerStats): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (playerStats.length > 0) {
            const items: Record<string, string> = {};
            playerStats.forEach((playerStat) => {
              items[playerStat.elementId.toString()] = JSON.stringify(playerStat);
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

  return {
    getLatestPlayerStats,
    setLatestPlayerStats,
  };
};
