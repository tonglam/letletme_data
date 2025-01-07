/**
 * Phase Operations Module
 *
 * Implements domain operations for phases using functional programming patterns.
 * Handles phase retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  PhaseCache,
  PhaseId,
  PhaseOperations as PhaseOps,
  PhaseRepository,
  Phases,
  toDomainPhase,
  toPrismaPhase,
} from './types';

/**
 * Creates phase operations with repository and cache integration
 */
export const createPhaseOperations = (
  repository: PhaseRepository,
  cache: PhaseCache,
): PhaseOps => ({
  getAllPhases: () =>
    pipe(
      cache.getAllPhases(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all phases: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPhases) =>
        cachedPhases.length > 0
          ? TE.right(cachedPhases)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch phases from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((phases) => phases.map(toDomainPhase)),
              TE.chainFirst((phases) =>
                pipe(
                  cache.cachePhases(phases),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache phases: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getPhaseById: (id: PhaseId) =>
    pipe(
      cache.getPhase(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get phase by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedPhase) =>
        cachedPhase
          ? TE.right(cachedPhase)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch phase from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((phase) => (phase ? toDomainPhase(phase) : null)),
              TE.chainFirst((phase) =>
                phase
                  ? pipe(
                      cache.cachePhase(phase),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache phase: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createPhases: (phases: Phases) =>
    pipe(
      repository.saveBatch(phases.map(toPrismaPhase)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create phases: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedPhases) => savedPhases.map(toDomainPhase)),
      TE.chainFirst((createdPhases) =>
        pipe(
          cache.cachePhases(createdPhases),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created phases: ${error.message}`,
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
          message: `Failed to delete all phases: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
