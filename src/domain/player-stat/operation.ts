/**
 * Player Stat Operations Module
 *
 * Implements domain operations for player stats using functional programming patterns.
 * Handles player stat retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import { EventOperations } from '../event/types';
import {
  PlayerStatCache,
  PlayerStatId,
  PlayerStatOperations,
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
  eventOperations: EventOperations,
): PlayerStatOperations => ({
  getAllPlayerStats: () =>
    pipe(
      eventOperations.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to get current event: ${error.message}`,
        }),
      ),
      TE.chain((currentEvent) =>
        currentEvent
          ? pipe(
              cache.getAllPlayerStats(currentEvent.id),
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
                      TE.map((playerStats) =>
                        playerStats.map((stat) => toDomainPlayerStat(stat, currentEvent.id)),
                      ),
                      TE.chainFirst((playerStats) =>
                        pipe(
                          cache.cachePlayerStats(playerStats, currentEvent.id),
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
            )
          : TE.right([]),
      ),
    ),

  getPlayerStatById: (id: PlayerStatId) =>
    pipe(
      eventOperations.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to get current event: ${error.message}`,
        }),
      ),
      TE.chain((currentEvent) =>
        currentEvent
          ? pipe(
              cache.getPlayerStat(id.toString(), currentEvent.id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.CACHE_ERROR,
                  message: `Failed to get player stat from cache: ${error.message}`,
                  cause: error,
                }),
              ),
            )
          : TE.right(null),
      ),
    ),

  createPlayerStats: (playerStats: PlayerStats) =>
    pipe(
      eventOperations.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to get current event: ${error.message}`,
        }),
      ),
      TE.chain((currentEvent) =>
        currentEvent
          ? pipe(
              repository.saveBatch(playerStats.map(toPrismaPlayerStat)),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to create player stats: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((savedPlayerStats) =>
                savedPlayerStats.map((stat) => toDomainPlayerStat(stat, currentEvent.id)),
              ),
              TE.chainFirst((createdPlayerStats) =>
                pipe(
                  cache.cachePlayerStats(createdPlayerStats, currentEvent.id),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache created player stats: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            )
          : TE.right([]),
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

  getPlayerStatByEventId: (eventId: number) =>
    pipe(
      cache.getAllPlayerStats(eventId),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get player stats by event id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayerStats) =>
        cachedPlayerStats.length > 0
          ? TE.right(cachedPlayerStats)
          : pipe(
              repository.findByEventId(eventId),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player stats by event id from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((playerStats) => playerStats.map((stat) => toDomainPlayerStat(stat, eventId))),
              TE.chainFirst((playerStats) =>
                pipe(
                  cache.cachePlayerStats(playerStats, eventId),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache player stats by event id: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getPlayerStatByElementId: (elementId: number) =>
    pipe(
      eventOperations.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to get current event: ${error.message}`,
        }),
      ),
      TE.chain((currentEvent) =>
        currentEvent
          ? pipe(
              cache.getPlayerStat(elementId.toString(), currentEvent.id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.CACHE_ERROR,
                  message: `Failed to get player stat by element id: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.chain((cachedPlayerStat) =>
                cachedPlayerStat
                  ? TE.right([cachedPlayerStat])
                  : pipe(
                      repository.findByElementId(elementId),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.DATABASE_ERROR,
                          message: `Failed to fetch player stats by element id from database: ${error.message}`,
                          cause: error,
                        }),
                      ),
                      TE.map((playerStats) =>
                        playerStats.map((stat) => toDomainPlayerStat(stat, currentEvent.id)),
                      ),
                      TE.chainFirst((playerStats) =>
                        pipe(
                          cache.cachePlayerStats(playerStats, currentEvent.id),
                          TE.mapLeft((error) =>
                            createDomainError({
                              code: DomainErrorCode.CACHE_ERROR,
                              message: `Failed to cache player stats by element id: ${error.message}`,
                              cause: error,
                            }),
                          ),
                        ),
                      ),
                    ),
              ),
            )
          : TE.right([]),
      ),
    ),

  getPlayerStatByTeamId: (teamId: number) =>
    pipe(
      eventOperations.getCurrentEvent(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to get current event: ${error.message}`,
        }),
      ),
      TE.chain((currentEvent) =>
        currentEvent
          ? pipe(
              cache.getAllPlayerStats(currentEvent.id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.CACHE_ERROR,
                  message: `Failed to get player stats from cache: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.chain((cachedPlayerStats) => {
                const teamStats = cachedPlayerStats.filter((stat) => stat.teamId === teamId);
                return teamStats.length > 0
                  ? TE.right(teamStats)
                  : pipe(
                      repository.findByTeamId(teamId),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.DATABASE_ERROR,
                          message: `Failed to fetch player stats by team id from database: ${error.message}`,
                          cause: error,
                        }),
                      ),
                      TE.map((playerStats) =>
                        playerStats.map((stat) => toDomainPlayerStat(stat, currentEvent.id)),
                      ),
                      TE.chainFirst((playerStats) =>
                        pipe(
                          cache.cachePlayerStats(playerStats, currentEvent.id),
                          TE.mapLeft((error) =>
                            createDomainError({
                              code: DomainErrorCode.CACHE_ERROR,
                              message: `Failed to cache player stats by team id: ${error.message}`,
                              cause: error,
                            }),
                          ),
                        ),
                      ),
                    );
              }),
            )
          : TE.right([]),
      ),
    ),
});
