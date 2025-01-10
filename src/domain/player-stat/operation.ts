/**
 * Player Stat Operations Module
 *
 * Implements domain operations for player stats using functional programming patterns.
 * Handles player stat retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  PlayerStatCache,
  PlayerStatId,
  PlayerStatOperations as PlayerStatOps,
  PlayerStatRepository,
  PlayerStats,
  toDomainPlayerStat,
  toPrismaPlayerStat,
} from './types';

/**
 * Creates player stat operations with repository and cache integration
 */
export const createPlayerStatOperations = (
  repository: PlayerStatRepository,
  cache: PlayerStatCache,
): PlayerStatOps => ({
  getAllPlayerStats: () =>
    pipe(
      cache.getAllPlayerStats(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all player stats: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayerStats) =>
        cachedPlayerStats.length > 0
          ? TE.right(cachedPlayerStats)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player stats from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((playerStats) => playerStats.map(toDomainPlayerStat)),
              TE.chainFirst((playerStats) =>
                pipe(
                  cache.cachePlayerStats(playerStats),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache player stats: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getPlayerStatById: (id: PlayerStatId) =>
    pipe(
      cache.getPlayerStat(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get player stat by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayerStat) =>
        cachedPlayerStat
          ? TE.right(cachedPlayerStat)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player stat from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((playerStat) => (playerStat ? toDomainPlayerStat(playerStat) : null)),
              TE.chainFirst((playerStat) =>
                playerStat
                  ? pipe(
                      cache.cachePlayerStat(playerStat),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache player stat: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createPlayerStats: (playerStats: PlayerStats) =>
    pipe(
      repository.saveBatch(playerStats.map(toPrismaPlayerStat)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create player stats: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedPlayerStats) => savedPlayerStats.map(toDomainPlayerStat)),
      TE.chainFirst((createdPlayerStats) =>
        pipe(
          cache.cachePlayerStats(createdPlayerStats),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created player stats: ${error.message}`,
              cause: error,
            }),
          ),
        ),
      ),
    ),

  deleteAll: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to delete all player stats: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
