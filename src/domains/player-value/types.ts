import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PrismaPlayerValueCreate } from 'src/repositories/player-value/type';
import { PlayerValue, PlayerValueId, PlayerValues } from 'src/types/domain/player-value.type';
import { DBError, DomainError } from 'src/types/error.type';

// ============ Repository Types ============

export interface PlayerValueRepository {
  readonly findAll: () => TE.TaskEither<DBError, PlayerValues>;
  readonly findById: (id: PlayerValueId) => TE.TaskEither<DBError, PlayerValue | null>;
  readonly saveBatch: (
    playerValues: readonly PrismaPlayerValueCreate[],
  ) => TE.TaskEither<DBError, PlayerValues>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface PlayerValueCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerValueCache {
  readonly getPlayerValue: (id: PlayerValueId) => TE.TaskEither<DomainError, PlayerValue | null>;
  readonly getAllPlayerValues: () => TE.TaskEither<DomainError, PlayerValues | null>;
  readonly setAllPlayerValues: (playerValues: PlayerValues) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayerValues: () => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface PlayerValueOperations {
  readonly getAllPlayerValues: () => TE.TaskEither<DomainError, PlayerValues>;
  readonly getPlayerValueById: (
    id: PlayerValueId,
  ) => TE.TaskEither<DomainError, PlayerValue | null>;
  readonly savePlayerValues: (
    playerValues: readonly PrismaPlayerValueCreate[],
  ) => TE.TaskEither<DomainError, PlayerValues>;
  readonly deleteAllPlayerValues: () => TE.TaskEither<DomainError, void>;
}
