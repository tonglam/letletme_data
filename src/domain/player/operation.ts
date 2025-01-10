/**
 * Player Operations Module
 *
 * Implements domain operations for players using functional programming patterns.
 * Handles player retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  PlayerCache,
  PlayerId,
  PlayerOperations as PlayerOps,
  PlayerRepository,
  Players,
  toDomainPlayer,
  toPrismaPlayer,
} from './types';

/**
 * Creates player operations with repository and cache integration
 */
export const createPlayerOperations = (
  repository: PlayerRepository,
  cache: PlayerCache,
): PlayerOps => ({
  getAllPlayers: () =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all players: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayers) =>
        cachedPlayers.length > 0
          ? TE.right(cachedPlayers)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch players from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((players) => players.map(toDomainPlayer)),
              TE.chainFirst((players) =>
                pipe(
                  cache.cachePlayers(players),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache players: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getPlayerById: (id: PlayerId) =>
    pipe(
      cache.getPlayer(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get player by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayer) =>
        cachedPlayer
          ? TE.right(cachedPlayer)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((player) => (player ? toDomainPlayer(player) : null)),
              TE.chainFirst((player) =>
                player
                  ? pipe(
                      cache.cachePlayer(player),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache player: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createPlayers: (players: Players) =>
    pipe(
      repository.saveBatch(players.map(toPrismaPlayer)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create players: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedPlayers) => savedPlayers.map(toDomainPlayer)),
      TE.chainFirst((createdPlayers) =>
        pipe(
          cache.cachePlayers(createdPlayers),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created players: ${error.message}`,
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
          message: `Failed to delete all players: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
