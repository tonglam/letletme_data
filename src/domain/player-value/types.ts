/**
 * Player Value Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import {
  PlayerValue,
  PlayerValueId,
  PlayerValueRepository,
  PlayerValues,
} from 'src/types/player-value.type';
import { BootstrapApi } from '../bootstrap/types';

/**
 * Player value data provider interface
 */
export interface PlayerValueDataProvider {
  readonly getOne: (id: number) => Promise<PlayerValue | null>;
  readonly getAll: () => Promise<readonly PlayerValue[]>;
}

/**
 * Player value cache configuration interface
 */
export interface PlayerValueCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Player value cache interface
 */
export interface PlayerValueCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePlayerValue: (playerValue: PlayerValue) => TE.TaskEither<CacheError, void>;
  readonly cachePlayerValues: (
    playerValues: readonly PlayerValue[],
  ) => TE.TaskEither<CacheError, void>;
  readonly getPlayerValue: (id: string) => TE.TaskEither<CacheError, PlayerValue | null>;
  readonly getAllPlayerValues: () => TE.TaskEither<CacheError, readonly PlayerValue[]>;
}

/**
 * Player value operations interface for domain logic
 */
export interface PlayerValueOperations {
  readonly getAllPlayerValues: () => TE.TaskEither<DomainError, PlayerValues>;
  readonly getPlayerValueById: (
    id: PlayerValueId,
  ) => TE.TaskEither<DomainError, PlayerValue | null>;
  readonly createPlayerValues: (
    playerValues: PlayerValues,
  ) => TE.TaskEither<DomainError, PlayerValues>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Service interface for Player Value operations
 */
export interface PlayerValueService {
  readonly getPlayerValues: () => TE.TaskEither<APIError, PlayerValues>;
  readonly getPlayerValue: (id: PlayerValueId) => TE.TaskEither<APIError, PlayerValue | null>;
  readonly savePlayerValues: (playerValues: PlayerValues) => TE.TaskEither<APIError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<APIError, PlayerValues>;
}

/**
 * Dependencies required by the PlayerValueService
 */
export interface PlayerValueServiceDependencies {
  bootstrapApi: BootstrapApi;
  playerValueCache: PlayerValueCache;
  playerValueRepository: PlayerValueRepository;
}

export * from '../../types/player-value.type';
