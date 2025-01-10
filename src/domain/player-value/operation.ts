/**
 * Player Value Operations Module
 *
 * Implements domain operations for player values using functional programming patterns.
 * Handles player value retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  PlayerValueCache,
  PlayerValueId,
  PlayerValueOperations as PlayerValueOps,
  PlayerValueRepository,
  PlayerValues,
  toDomainPlayerValue,
  toPrismaPlayerValue,
} from './types';

/**
 * Creates player value operations with repository and cache integration
 */
export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
  cache: PlayerValueCache,
): PlayerValueOps => ({
  getAllPlayerValues: () =>
    pipe(
      cache.getAllPlayerValues(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all player values: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayerValues) =>
        cachedPlayerValues.length > 0
          ? TE.right(cachedPlayerValues)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player values from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
              TE.chainFirst((playerValues) =>
                pipe(
                  cache.cachePlayerValues(playerValues),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache player values: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getPlayerValueById: (id: PlayerValueId) =>
    pipe(
      cache.getPlayerValue(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get player value by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPlayerValue) =>
        cachedPlayerValue
          ? TE.right(cachedPlayerValue)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch player value from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((playerValue) => (playerValue ? toDomainPlayerValue(playerValue) : null)),
              TE.chainFirst((playerValue) =>
                playerValue
                  ? pipe(
                      cache.cachePlayerValue(playerValue),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache player value: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createPlayerValues: (playerValues: PlayerValues) =>
    pipe(
      repository.saveBatch(playerValues.map(toPrismaPlayerValue)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create player values: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedPlayerValues) => savedPlayerValues.map(toDomainPlayerValue)),
      TE.chainFirst((createdPlayerValues) =>
        pipe(
          cache.cachePlayerValues(createdPlayerValues),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created player values: ${error.message}`,
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
          message: `Failed to delete all player values: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
