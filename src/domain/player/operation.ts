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
      repository.findAll(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch all players: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((players) => players.map(toDomainPlayer)),
    ),

  getPlayerById: (id: PlayerId) =>
    pipe(
      repository.findById(id),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((player) => (player ? toDomainPlayer(player) : null)),
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
      TE.chainFirstW((savedPlayers) =>
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
