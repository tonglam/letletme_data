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
  PlayerId,
  PlayerRepository,
  Players,
  toDomainPlayer,
  toPrismaPlayer,
} from '../../types/player.type';
import { PlayerCache, PlayerOperations } from './types';

/**
 * Creates player operations with repository and cache integration
 */
export const createPlayerOperations = (
  repository: PlayerRepository,
  cache: PlayerCache,
): PlayerOperations => ({
  getAllPlayers: () =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get players from cache: ${error.message}`,
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
                  message: `Failed to fetch all players: ${error.message}`,
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
          message: `Failed to get player from cache: ${error.message}`,
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
                  message: `Failed to fetch player by id: ${error.message}`,
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
                  : TE.right(undefined),
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
      TE.chainFirst((savedPlayers) =>
        pipe(
          cache.cachePlayers(savedPlayers),
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

  updatePrices: (updates: readonly { id: PlayerId; price: number }[]) =>
    pipe(
      repository.updatePrices(updates),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to update player prices: ${error.message}`,
          cause: error instanceof Error ? error : new Error(String(error)),
        }),
      ),
      TE.chainFirst(() =>
        pipe(
          cache.warmUp(),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to refresh cache after price updates: ${error.message}`,
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
      TE.chainFirst(() =>
        pipe(
          cache.warmUp(),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to refresh cache after deletion: ${error.message}`,
              cause: error,
            }),
          ),
        ),
      ),
    ),
});
