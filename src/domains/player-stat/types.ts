import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PlayerStats } from 'src/types/domain/player-stat.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerStatCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerStatCache {
  readonly getAllPlayerStats: () => TE.TaskEither<DomainError, PlayerStats>;
  readonly setAllPlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayerStats: () => TE.TaskEither<DomainError, void>;
}

export interface PlayerStatOperations {
  readonly savePlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, PlayerStats>;
  readonly deleteAllPlayerStats: () => TE.TaskEither<DomainError, void>;
}
