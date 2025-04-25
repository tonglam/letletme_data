import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { PlayerStatCreateInputs } from 'src/repositories/player-stat/types';
import { PlayerStats, RawPlayerStats } from 'src/types/domain/player-stat.type';
import { DomainError } from 'src/types/error.type';

export interface PlayerStatCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface PlayerStatCache {
  readonly getLatestPlayerStats: () => TE.TaskEither<DomainError, PlayerStats>;
  readonly setLatestPlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, void>;
}

export interface PlayerStatOperations {
  readonly getLatestPlayerStats: () => TE.TaskEither<DomainError, RawPlayerStats>;
  readonly saveLatestPlayerStats: (
    playerStatInputs: PlayerStatCreateInputs,
  ) => TE.TaskEither<DomainError, RawPlayerStats>;
  readonly deleteLatestPlayerStats: () => TE.TaskEither<DomainError, void>;
}
