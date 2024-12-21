import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/api/common/errors';
import { createValidationError } from '../../infrastructure/api/common/errors';
import type { Phase as DomainPhase, PrismaPhase, PrismaPhaseCreate } from '../../types/phase.type';
import type { PhaseCacheOperations } from './cache/cache';
import { phaseRepository } from './repository';

const toPrismaPhase = (phase: DomainPhase): PrismaPhaseCreate => ({
  id: phase.id,
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: null,
  createdAt: new Date(),
});

export const createError = (message: string, cause?: unknown): APIError =>
  createValidationError({ message, details: { cause } });

export const savePhase = (phase: DomainPhase): TE.TaskEither<APIError, PrismaPhase> =>
  phaseRepository.save(toPrismaPhase(phase));

export const cachePhase =
  (cache: PhaseCacheOperations) =>
  (phase: DomainPhase): TE.TaskEither<APIError, void> =>
    pipe(
      cache.cachePhases([{ ...phase, createdAt: new Date() }]),
      TE.mapLeft((error) => createError('Failed to cache phase', error)),
    );

export const findActivePhase =
  (currentEventId: number) =>
  (phases: readonly PrismaPhase[]): PrismaPhase | null =>
    phases.find(
      (phase) => phase.startEvent <= currentEventId && phase.stopEvent >= currentEventId,
    ) ?? null;
