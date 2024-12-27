import * as TE from 'fp-ts/TaskEither';
import { type BaseDataProvider } from '../../infrastructure/cache/core/cache';
import {
  createDomainCache,
  type DomainCacheOperations,
} from '../../infrastructure/cache/core/domain-cache';
import { CacheError, RedisClient } from '../../infrastructure/cache/types';
import { PrismaTeam } from '../../types/teams.type';

export type TeamDataProvider = BaseDataProvider<PrismaTeam>;

export interface TeamCacheOperations extends DomainCacheOperations<PrismaTeam> {
  readonly cacheTeam: (team: PrismaTeam) => TE.TaskEither<CacheError, void>;
  readonly getTeam: (id: string) => TE.TaskEither<CacheError, PrismaTeam | null>;
  readonly cacheTeams: (teams: readonly PrismaTeam[]) => TE.TaskEither<CacheError, void>;
  readonly getAllTeams: () => TE.TaskEither<CacheError, readonly PrismaTeam[]>;
}

export const createTeamOperations = (
  redis: RedisClient,
  dataProvider: TeamDataProvider,
): TeamCacheOperations => {
  const domainCache = createDomainCache(redis, 'TEAM', dataProvider, 'team', (baseOps) => ({
    cacheTeam: baseOps.cacheItem,
    getTeam: baseOps.getItem,
    cacheTeams: baseOps.cacheItems,
    getAllTeams: baseOps.getAllItems,
  }));

  return domainCache as TeamCacheOperations;
};

export type TeamCache = ReturnType<typeof createTeamOperations>;
