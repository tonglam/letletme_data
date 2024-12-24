import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { fetchBootstrapData } from '../../domains/bootstrap/operations';
import type { PhaseCache } from '../../domains/phases/cache/cache';
import { APIError, createValidationError } from '../../infrastructure/api/common/errors';
import type { CacheError } from '../../infrastructure/cache/types';
import type { Phase, PhaseId, PrismaPhase, PrismaPhaseCreate } from '../../types/phase.type';
import type { PhaseService, PhaseServiceDependencies } from './types';

const createSyncError = (message: string, error: unknown): APIError =>
  createValidationError({
    message: `${message}: ${error}`,
    details: { originalError: error },
  });

const validatePhasesExist = (
  phases: readonly Phase[],
): TE.TaskEither<APIError, readonly Phase[]> =>
  phases.length > 0
    ? TE.right(phases)
    : TE.left(createValidationError({ message: 'No phases found' }));

const validatePhaseExists =
  (id: PhaseId) =>
  (phase: Phase | null): TE.TaskEither<APIError, Phase | null> =>
    phase ? TE.right(phase) : TE.left(createValidationError({ message: `Phase ${id} not found` }));

const toPrismaPhaseCreate = (phase: Phase): PrismaPhaseCreate => ({
  id: Number(phase.id),
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: phase.highestScore,
  createdAt: new Date(),
});

const toPrismaPhase = (phase: Phase): PrismaPhase => ({
  id: Number(phase.id),
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: phase.highestScore,
  createdAt: new Date(),
});

const toDomainPhase = (prismaPhase: PrismaPhase): Phase => ({
  id: prismaPhase.id as PhaseId,
  name: prismaPhase.name,
  startEvent: prismaPhase.startEvent,
  stopEvent: prismaPhase.stopEvent,
  highestScore: prismaPhase.highestScore,
});

const savePhases =
  (repository: PhaseServiceDependencies['phaseRepository'], cache: PhaseCache | undefined) =>
  (phases: readonly Phase[]): TE.TaskEither<APIError, readonly Phase[]> =>
    pipe(
      repository.saveBatch(phases.map(toPrismaPhaseCreate)),
      TE.map((savedPhases) => savedPhases.map(toDomainPhase)),
      TE.chainFirst(() =>
        cache
          ? pipe(
              TE.traverseArray((phase: Phase) => cache.cachePhase(toPrismaPhase(phase)))(phases),
              TE.mapLeft((error) =>
                createValidationError({ message: 'Failed to cache phases', details: { error } }),
              ),
            )
          : TE.right(undefined),
      ),
    );

const findActivePhase =
  (currentEventId: number) =>
  (phases: readonly Phase[]): Phase | null =>
    phases.find(
      (phase) => phase.startEvent <= currentEventId && phase.stopEvent >= currentEventId,
    ) ?? null;

const validatePhaseSequence = (
  phases: readonly Phase[],
): TE.TaskEither<APIError, readonly Phase[]> => {
  // Skip the "Overall" phase when checking for overlaps
  const monthlyPhases = phases.filter((phase) => phase.name !== 'Overall');

  for (let i = 1; i < monthlyPhases.length; i++) {
    if (monthlyPhases[i].startEvent <= monthlyPhases[i - 1].stopEvent) {
      return TE.left(
        createValidationError({ message: 'Phase sequence invalid: overlapping phases detected' }),
      );
    }
  }
  return TE.right(phases);
};

export const createPhaseServiceImpl = ({
  bootstrapApi,
  phaseCache,
  phaseRepository,
}: PhaseServiceDependencies): PhaseService => {
  const syncPhases = () =>
    pipe(
      fetchBootstrapData(bootstrapApi),
      TE.mapLeft((error) => createSyncError('Bootstrap data fetch failed', error)),
      TE.chain(validatePhaseSequence),
      TE.chain(savePhases(phaseRepository, phaseCache)),
    );

  const getPhases = () =>
    pipe(
      phaseCache?.getAllPhases() ?? phaseRepository.findAll(),
      TE.mapLeft((error: CacheError | APIError) =>
        createValidationError({ message: 'Failed to get phases', details: { error } }),
      ),
      TE.map((phases) => phases.map(toDomainPhase)),
      TE.chain(validatePhasesExist),
    );

  const getPhase = (id: PhaseId) =>
    pipe(
      phaseCache?.getPhase(String(id)) ?? phaseRepository.findById(id),
      TE.mapLeft((error: CacheError | APIError) =>
        createValidationError({ message: 'Failed to get phase', details: { error } }),
      ),
      TE.map((phase) => (phase ? toDomainPhase(phase) : null)),
      TE.chain(validatePhaseExists(id)),
    );

  const getCurrentActivePhase = (currentEventId: number) =>
    pipe(getPhases(), TE.map(findActivePhase(currentEventId)));

  return {
    syncPhases,
    getPhases,
    getPhase,
    getCurrentActivePhase,
  };
};
