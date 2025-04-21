import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PlayerStatCreateInputs } from 'src/repositories/player-stat/type';
import { SourcePlayerStats } from 'src/types/domain/player-stat.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerStatCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerStatCache {
  readonly getLatestPlayerStats: () => TE.TaskEither<DomainError, SourcePlayerStats>;
  readonly setLatestPlayerStats: (
    playerStats: SourcePlayerStats,
  ) => TE.TaskEither<DomainError, void>;
  readonly deleteLatestPlayerStats: () => TE.TaskEither<DomainError, void>;
}

export interface PlayerStatOperations {
  readonly saveLatestPlayerStats: (
    playerStats: PlayerStatCreateInputs,
  ) => TE.TaskEither<DomainError, SourcePlayerStats>;
  readonly deleteLatestPlayerStats: () => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayerStats: () => TE.TaskEither<DomainError, void>;
}
