/**
 * Player Value Operations Module
 *
 * Implements domain operations for player values using functional programming patterns.
 * Handles player value retrieval, creation, and cache management.
 */

import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ValueChangeType } from '../../types/base.type';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  PlayerValueCache,
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
  getPlayerValueByChangeDate: (changeDate: string) =>
    pipe(
      repository.findByChangeDate(changeDate),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player values by change date: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
      TE.chainFirstW((playerValues) =>
        pipe(
          cache.findByChangeDate(changeDate),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to update cache: ${error.message}`,
              cause: error,
            }),
          ),
          TE.orElse(() => TE.right(playerValues as PlayerValues)),
        ),
      ),
    ),

  getPlayerValueByElementId: (elementId: number) =>
    pipe(
      repository.findByElementId(elementId),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player values by element id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
    ),

  getPlayerValueByElementType: (elementType: number) =>
    pipe(
      repository.findByElementType(elementType),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player values by element type: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
    ),

  getPlayerValueByEventId: (eventId: number) =>
    pipe(
      repository.findByEventId(eventId),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player values by event id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
    ),

  getPlayerValueByChangeType: (changeType: ValueChangeType) =>
    pipe(
      repository.findByChangeType(changeType),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch player values by change type: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((playerValues) => playerValues.map(toDomainPlayerValue)),
    ),

  createPlayerValues: (playerValues: PlayerValues) =>
    pipe(
      [...playerValues],
      // Convert each value to a TaskEither that handles the save operation
      A.traverse(TE.ApplicativePar)((value) =>
        pipe(
          repository.save(toPrismaPlayerValue(value)),
          TE.orElse((error) => {
            const isUniqueViolation =
              error.message.toLowerCase().includes('unique constraint') ||
              error.message.toLowerCase().includes('duplicate');

            return isUniqueViolation
              ? pipe(
                  repository.findByChangeDate(value.changeDate),
                  TE.map((existingValues) => {
                    const found = existingValues.find(
                      (existing) =>
                        existing.elementId === value.elementId &&
                        existing.changeDate === value.changeDate,
                    );
                    return found ?? null;
                  }),
                )
              : TE.left(error);
          }),
        ),
      ),
      // Filter out nulls and map to domain type
      TE.map(A.filterMap((result) => (result ? O.some(toDomainPlayerValue(result)) : O.none))),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create player values: ${error.message}`,
          cause: error,
        }),
      ),
      // Update cache with successfully saved values
      TE.chainFirstW((savedValues) =>
        savedValues.length > 0
          ? pipe(
              cache.findByChangeDate(savedValues[0].changeDate),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.CACHE_ERROR,
                  message: `Failed to update cache: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.orElse(() => TE.right(savedValues as PlayerValues)),
            )
          : TE.right([] as PlayerValues),
      ),
    ),
});
