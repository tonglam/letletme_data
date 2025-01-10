/**
 * Team Domain Types Module
 * Contains type definitions for the team domain layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import { Team, TeamId, TeamRepository, Teams } from 'src/types/team.type';
import { BootstrapApi } from '../bootstrap/types';

/**
 * Data provider interface for team cache
 */
export interface TeamDataProvider {
  readonly getOne: (id: number) => Promise<Team | null>;
  readonly getAll: () => Promise<readonly Team[]>;
}

/**
 * Configuration for team cache operations
 */
export interface TeamCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Cache operations for team domain
 */
export interface TeamCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cacheTeam: (team: Team) => TE.TaskEither<CacheError, void>;
  readonly cacheTeams: (teams: readonly Team[]) => TE.TaskEither<CacheError, void>;
  readonly getTeam: (id: string) => TE.TaskEither<CacheError, Team | null>;
  readonly getAllTeams: () => TE.TaskEither<CacheError, readonly Team[]>;
}

/**
 * High-level domain operations for team
 */
export interface TeamOperations {
  readonly getAllTeams: () => TE.TaskEither<DomainError, Teams>;
  readonly getTeamById: (id: TeamId) => TE.TaskEither<DomainError, Team | null>;
  readonly createTeams: (teams: Teams) => TE.TaskEither<DomainError, Teams>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Team service interface
 */
export interface TeamService {
  readonly getTeams: () => TE.TaskEither<APIError, Teams>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<APIError, Team | null>;
  readonly saveTeams: (teams: readonly Team[]) => TE.TaskEither<APIError, Teams>;
  readonly syncTeamsFromApi: () => TE.TaskEither<APIError, Teams>;
}

/**
 * Team service dependencies interface
 */
export interface TeamServiceDependencies {
  bootstrapApi: BootstrapApi;
  teamCache: TeamCache;
  teamRepository: TeamRepository;
}

export * from '../../types/team.type';
