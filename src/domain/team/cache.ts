/**
 * Team Cache Module
 * Provides caching functionality for FPL teams using Redis as the cache store.
 * Implements Cache-Aside pattern for efficient data access and reduced database load.
 * Uses TaskEither for error handling and functional composition,
 * ensuring type-safety and predictable error states throughout the caching layer.
 */

import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { flow, pipe } from 'fp-ts/function';
import { CachePrefix } from '../../config/cache/cache.config';
import { redisClient } from '../../infrastructure/cache/client';
import type { RedisCache } from '../../infrastructure/cache/redis-cache';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError } from '../../types/error.type';
import type { Team } from '../../types/team.type';
import { TeamCache, TeamCacheConfig, TeamDataProvider } from './types';

const parseTeam = (teamStr: string): E.Either<CacheError, Team | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(teamStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse team JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Team)
        : E.right(null),
    ),
  );

const parseTeams = (teams: Record<string, string>): E.Either<CacheError, Team[]> =>
  pipe(
    Object.values(teams),
    (teamStrs) =>
      teamStrs.map((str) =>
        pipe(
          parseTeam(str),
          E.getOrElse<CacheError, Team | null>(() => null),
        ),
      ),
    (parsedTeams) => parsedTeams.filter((team): team is Team => team !== null),
    (validTeams) => E.right(validTeams),
  );

export const createTeamCache = (
  cache: RedisCache<Team>,
  dataProvider: TeamDataProvider,
  config: TeamCacheConfig = {
    keyPrefix: CachePrefix.TEAM,
    season: getCurrentSeason(),
  },
): TeamCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const warmUp = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const teams = await dataProvider.getAll();
          await redisClient.del(baseKey);
          const cacheMulti = redisClient.multi();
          teams.forEach((team) => {
            cacheMulti.hset(baseKey, team.id.toString(), JSON.stringify(team));
          });
          await cacheMulti.exec();
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to warm up cache',
            cause: error as Error,
          }),
      ),
    );

  const cacheTeam = (team: Team): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hset(baseKey, team.id.toString(), JSON.stringify(team)),
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache team',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const cacheTeams = (teams: readonly Team[]): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (teams.length === 0) return;
          await redisClient.del(baseKey);
          const cacheMulti = redisClient.multi();
          teams.forEach((team) => {
            cacheMulti.hset(baseKey, team.id.toString(), JSON.stringify(team));
          });
          await cacheMulti.exec();
        },
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to cache teams',
            cause: error as Error,
          }),
      ),
    );

  const getTeam = (id: string): TE.TaskEither<CacheError, Team | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id),
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get team from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getOne(Number(id)),
                  (error) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get team from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chainFirst((team) => (team ? cacheTeam(team) : TE.right(undefined))),
              ),
            (teamStr) =>
              pipe(
                parseTeam(teamStr),
                TE.fromEither,
                TE.chain((team) =>
                  team
                    ? TE.right(team)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getOne(Number(id)),
                          (error) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get team from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chainFirst((team) => (team ? cacheTeam(team) : TE.right(undefined))),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  const getAllTeams = (): TE.TaskEither<CacheError, readonly Team[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to get teams from cache',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                TE.tryCatch(
                  () => dataProvider.getAll(),
                  (error) =>
                    createCacheError({
                      code: CacheErrorCode.OPERATION_ERROR,
                      message: 'Failed to get teams from provider',
                      cause: error as Error,
                    }),
                ),
                TE.chain((teams) =>
                  pipe(
                    cacheTeams(teams),
                    TE.map(() => teams),
                  ),
                ),
              ),
            (cachedTeams) =>
              pipe(
                parseTeams(cachedTeams),
                TE.fromEither,
                TE.chain((teams) =>
                  teams.length > 0
                    ? TE.right(teams)
                    : pipe(
                        TE.tryCatch(
                          () => dataProvider.getAll(),
                          (error) =>
                            createCacheError({
                              code: CacheErrorCode.OPERATION_ERROR,
                              message: 'Failed to get teams from provider',
                              cause: error as Error,
                            }),
                        ),
                        TE.chain((teams) =>
                          pipe(
                            cacheTeams(teams),
                            TE.map(() => teams),
                          ),
                        ),
                      ),
                ),
              ),
          ),
        ),
      ),
    );

  return {
    warmUp,
    cacheTeam,
    cacheTeams,
    getTeam,
    getAllTeams,
  };
};
