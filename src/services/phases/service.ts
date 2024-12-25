import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { fetchBootstrapData } from '../../domains/bootstrap/operations';
import {
  cachePhase,
  createError,
  findActivePhase,
  findAllPhases,
  findPhaseById,
  saveBatchPhases,
  toDomainPhase,
  validatePhaseSequence,
} from '../../domains/phases/operations';
import type { APIError } from '../../infrastructure/api/common/errors';
import type { CacheError } from '../../infrastructure/cache/types';
import type { Phase, PhaseId, PrismaPhase } from '../../types/phases.type';
import type { PhaseService, PhaseServiceDependencies } from './types';

const convertPrismaPhases = (
  phases: readonly PrismaPhase[],
): TE.TaskEither<APIError, readonly Phase[]> =>
  pipe(
    phases,
    TE.traverseArray((phase) =>
      pipe(
        E.tryCatch(
          () => toDomainPhase(phase),
          (error) => createError('Failed to convert phase', error),
        ),
        TE.fromEither,
      ),
    ),
  );

const convertPrismaPhase = (phase: PrismaPhase | null): TE.TaskEither<APIError, Phase | null> =>
  phase
    ? pipe(
        E.tryCatch(
          () => toDomainPhase(phase),
          (error) => createError('Failed to convert phase', error),
        ),
        TE.fromEither,
      )
    : TE.right(null);

const getCachedOrFallback = <T, R>(
  cachedValue: TE.TaskEither<CacheError, T> | undefined,
  fallback: TE.TaskEither<APIError, R>,
  convert: (value: T) => TE.TaskEither<APIError, R>,
): TE.TaskEither<APIError, R> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error) => createError('Cache operation failed', error)),
        TE.chain(convert),
      )
    : fallback;

export const createPhaseServiceImpl = ({
  bootstrapApi,
  phaseCache,
}: PhaseServiceDependencies): PhaseService => {
  const syncPhases = (): TE.TaskEither<APIError, readonly Phase[]> =>
    pipe(
      fetchBootstrapData(bootstrapApi),
      TE.mapLeft((error) => createError('Bootstrap data fetch failed', error)),
      TE.chain((phases) => validatePhaseSequence([...phases])),
      TE.chain((phases) =>
        pipe(
          saveBatchPhases(phases),
          TE.chainFirst((savedPhases) =>
            phaseCache
              ? pipe(
                  savedPhases,
                  TE.traverseArray((phase) => cachePhase(phaseCache)(phase)),
                  TE.mapLeft((error) => createError('Failed to cache phases', error)),
                )
              : TE.right(undefined),
          ),
        ),
      ),
    );

  const getPhases = (): TE.TaskEither<APIError, readonly Phase[]> =>
    getCachedOrFallback(phaseCache?.getAllPhases(), findAllPhases(), convertPrismaPhases);

  const getPhase = (id: PhaseId): TE.TaskEither<APIError, Phase | null> =>
    getCachedOrFallback(phaseCache?.getPhase(String(id)), findPhaseById(id), convertPrismaPhase);

  const getCurrentActivePhase = (currentEventId: number): TE.TaskEither<APIError, Phase | null> =>
    pipe(getPhases(), TE.map(findActivePhase(currentEventId)));

  return {
    syncPhases,
    getPhases,
    getPhase,
    getCurrentActivePhase,
  };
};
