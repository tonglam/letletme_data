/**
 * Player Stat Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import * as TE from 'fp-ts/TaskEither';
import type { CacheError, DomainError } from '../../types/error.type';
import type { PlayerStat, PlayerStatId, PlayerStats } from '../../types/player-stat.type';

/**
 * Player stat data provider interface
 */
export interface PlayerStatDataProvider {
  getOneByEvent: (id: number, eventId: number) => Promise<PlayerStat | null>;
  getAllByEvent: (eventId: number) => Promise<PlayerStat[]>;
}

/**
 * Player stat cache configuration interface
 */
export interface PlayerStatCacheConfig {
  keyPrefix: string;
  season: string;
  eventId: number;
}

/**
 * Player stat cache interface
 */
export interface PlayerStatCache {
  warmUp: (eventId?: number) => TE.TaskEither<CacheError, void>;
  cachePlayerStat: (playerStat: PlayerStat, eventId?: number) => TE.TaskEither<CacheError, void>;
  cachePlayerStats: (
    playerStats: readonly PlayerStat[],
    eventId?: number,
  ) => TE.TaskEither<CacheError, void>;
  getPlayerStat: (id: string, eventId?: number) => TE.TaskEither<CacheError, PlayerStat | null>;
  getAllPlayerStats: (eventId?: number) => TE.TaskEither<CacheError, readonly PlayerStat[]>;
}

/**
 * Player stat operations interface
 */
export interface PlayerStatOperations {
  readonly getAllPlayerStats: () => TE.TaskEither<DomainError, PlayerStats>;
  readonly getPlayerStatById: (id: PlayerStatId) => TE.TaskEither<DomainError, PlayerStat | null>;
  readonly getPlayerStatByEventId: (eventId: number) => TE.TaskEither<DomainError, PlayerStats>;
  readonly getPlayerStatByElementId: (elementId: number) => TE.TaskEither<DomainError, PlayerStats>;
  readonly getPlayerStatByTeamId: (teamId: number) => TE.TaskEither<DomainError, PlayerStats>;
  readonly createPlayerStats: (playerStats: PlayerStats) => TE.TaskEither<DomainError, PlayerStats>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

export * from '../../types/player-stat.type';
