/**
 * Player Stat Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import {
  PlayerStat,
  PlayerStatId,
  PlayerStatRepository,
  PlayerStats,
} from 'src/types/player-stat.type';
import { BootstrapApi } from '../bootstrap/types';

/**
 * Player stat data provider interface
 */
export interface PlayerStatDataProvider {
  readonly getOne: (id: number) => Promise<PlayerStat | null>;
  readonly getAll: () => Promise<readonly PlayerStat[]>;
}

/**
 * Player stat cache configuration interface
 */
export interface PlayerStatCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Player stat cache interface
 */
export interface PlayerStatCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePlayerStat: (playerStat: PlayerStat) => TE.TaskEither<CacheError, void>;
  readonly cachePlayerStats: (
    playerStats: readonly PlayerStat[],
  ) => TE.TaskEither<CacheError, void>;
  readonly getPlayerStat: (id: string) => TE.TaskEither<CacheError, PlayerStat | null>;
  readonly getAllPlayerStats: () => TE.TaskEither<CacheError, readonly PlayerStat[]>;
}

/**
 * Player stat operations interface for domain logic
 */
export interface PlayerStatOperations {
  readonly getAllPlayerStats: () => TE.TaskEither<DomainError, PlayerStats>;
  readonly getPlayerStatById: (id: PlayerStatId) => TE.TaskEither<DomainError, PlayerStat | null>;
  readonly createPlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, PlayerStats>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Service interface for Player Stat operations
 */
export interface PlayerStatService {
  readonly getPlayerStats: () => TE.TaskEither<APIError, PlayerStats>;
  readonly getPlayerStat: (id: PlayerStatId) => TE.TaskEither<APIError, PlayerStat | null>;
  readonly savePlayerStats: (playerStats: PlayerStats) => TE.TaskEither<APIError, PlayerStats>;
  readonly syncPlayerStatsFromApi: () => TE.TaskEither<APIError, PlayerStats>;
}

/**
 * Dependencies required by the PlayerStatService
 */
export interface PlayerStatServiceDependencies {
  bootstrapApi: BootstrapApi;
  playerStatCache: PlayerStatCache;
  playerStatRepository: PlayerStatRepository;
}

export * from '../../types/player-stat.type';
