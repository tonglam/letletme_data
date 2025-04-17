import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { PrismaPhaseCreate } from '../../repositories/phase/type';
import { PhaseId } from '../../types/domain/phase.type';
import { createDomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';
import { PhaseCache, PhaseOperations, PhaseRepository } from './types';

export const createPhaseOperations = (
  repository: PhaseRepository,
  cache: PhaseCache,
): PhaseOperations => ({
  getAllPhases: () =>
    pipe(
      cache.getAllPhases(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllPhases): ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.chain((cachedPhases) =>
        cachedPhases && cachedPhases.length > 0
          ? TE.right(cachedPhases)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
              TE.chainFirst((phases) =>
                phases && phases.length > 0
                  ? pipe(
                      cache.setAllPhases(phases),
                      TE.mapLeft((cacheError) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllPhases): ${getErrorMessage(cacheError)}`,
                          cause: cacheError instanceof Error ? cacheError : undefined,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getPhaseById: (id: PhaseId) =>
    pipe(
      cache.getPhase(id),
      TE.chain((cachedPhase) =>
        cachedPhase
          ? TE.right(cachedPhase)
          : pipe(
              repository.findById(id),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findById ${id}): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
            ),
      ),
    ),

  savePhases: (phases: readonly PrismaPhaseCreate[]) =>
    pipe(
      repository.saveBatch(phases),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst((createdPhases) =>
        pipe(
          cache.setAllPhases(createdPhases),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllPhases): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),

  deleteAllPhases: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst(() => pipe(cache.deleteAllPhases())),
    ),
});
