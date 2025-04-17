import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { PrismaPlayerStatCreateInput } from 'src/repositories/player-stat/type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerStat, PlayerStatId, PlayerStats } from 'src/types/domain/player-stat.type';
import { DBError, DomainError } from 'src/types/error.type';

// ============ Repository Types ============

export interface PlayerStatRepository {
  readonly findAll: () => TE.TaskEither<DBError, PlayerStats>;
  readonly findById: (id: PlayerStatId) => TE.TaskEither<DBError, PlayerStat | null>;
  readonly saveBatch: (
    playerStats: readonly PrismaPlayerStatCreateInput[],
  ) => TE.TaskEither<DBError, PlayerStats>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface PlayerStatCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface PlayerStatCache {
  readonly getPlayerStat: (id: PlayerStatId) => TE.TaskEither<DomainError, PlayerStat | null>;
  readonly getAllPlayerStats: () => TE.TaskEither<DomainError, PlayerStats | null>;
  readonly setAllPlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, void>;
  readonly deleteAllPlayerStats: () => TE.TaskEither<DomainError, void>;
  readonly deletePlayerStatsByEventId: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface PlayerStatOperations {
  readonly getAllPlayerStats: () => TE.TaskEither<DomainError, PlayerStats>;
  readonly getPlayerStatById: (id: PlayerStatId) => TE.TaskEither<DomainError, PlayerStat | null>;
  readonly savePlayerStats: (
    playerStats: readonly PrismaPlayerStatCreateInput[],
  ) => TE.TaskEither<DomainError, PlayerStats>;
  readonly deleteAllPlayerStats: () => TE.TaskEither<DomainError, void>;
  readonly deletePlayerStatsByEventId: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}
