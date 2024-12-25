import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from '../../../infrastructure/cache/config/cache.config';
import {
  createBaseCacheOperations,
  type BaseCacheOperations,
  type BaseDataProvider,
} from '../../../infrastructure/cache/core/base-cache';
import { createCache, type RedisCache } from '../../../infrastructure/cache/core/cache';
import { CacheError, RedisClient } from '../../../infrastructure/cache/types';
import { PrismaTeam } from '../../../types/teams.type';

export type TeamDataProvider = BaseDataProvider<PrismaTeam>;

export interface TeamCacheOperations extends BaseCacheOperations<PrismaTeam> {
  readonly cacheTeam: (team: PrismaTeam) => TE.TaskEither<CacheError, void>;
  readonly getTeam: (id: string) => TE.TaskEither<CacheError, PrismaTeam | null>;
  readonly cacheTeams: (teams: readonly PrismaTeam[]) => TE.TaskEither<CacheError, void>;
  readonly getAllTeams: () => TE.TaskEither<CacheError, readonly PrismaTeam[]>;
}

export const createTeamCache = (redis: RedisClient) =>
  createCache<PrismaTeam>(redis, CachePrefix.TEAM);

export const createTeamOperations = (
  cache: RedisCache<PrismaTeam>,
  dataProvider: TeamDataProvider,
): TeamCacheOperations => {
  const baseOperations = createBaseCacheOperations(
    cache,
    {
      getAll: dataProvider.getAll,
      getOne: dataProvider.getOne,
    },
    'team',
  );

  return {
    ...baseOperations,
    cacheTeam: baseOperations.cacheOne,
    getTeam: baseOperations.getOne,
    cacheTeams: baseOperations.cacheMany,
    getAllTeams: baseOperations.getAll,
  };
};

export type TeamCache = ReturnType<typeof createTeamOperations>;
