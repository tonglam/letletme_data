/**
 * Player Value Operations Module
 *
 * Implements domain operations for player values using functional programming patterns.
 * Handles player value retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ValueChangeType } from '../../types/base.type';
import { createDomainError, DomainErrorCode } from '../../types/error.type';
import {
  PlayerValueRepository,
  PlayerValues,
  toDomainPlayerValue,
  toPrismaPlayerValue,
} from '../../types/player-value.type';
import { PlayerValueOperations } from './types';

/**
 * Creates player value operations with repository and cache integration
 */
export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
): PlayerValueOperations => ({
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
      TE.map((values) => values.map(toDomainPlayerValue)),
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
      TE.map((values) => values.map(toDomainPlayerValue)),
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
      TE.map((values) => values.map(toDomainPlayerValue)),
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
      TE.map((values) => values.map(toDomainPlayerValue)),
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
      TE.map((values) => values.map(toDomainPlayerValue)),
    ),

  getLatestPlayerValues: () =>
    pipe(
      repository.findLatestByElements(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to fetch latest player values: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((values) => values.map(toDomainPlayerValue)),
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
      TE.map((values) => values.map(toDomainPlayerValue)),
    ),
});
