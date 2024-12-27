import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from 'src/utils/domain';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  Phase as DomainPhase,
  PhaseId,
  PrismaPhase,
  toDomainPhase,
  toPrismaPhase,
} from '../../types/phases.type';
import type { PhaseCacheOperations } from './cache';
import { phaseRepository } from './repository';

const { single, array } = createDomainOperations<DomainPhase, PrismaPhase>({
  toDomain: toDomainPhase,
  toPrisma: toPrismaPhase,
});

export const savePhase = (phase: DomainPhase): TE.TaskEither<APIError, DomainPhase> =>
  pipe(
    phaseRepository.save(single.fromDomain(phase)),
    TE.map(single.toDomain),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save phase' })),
    ),
  );

export const cachePhase =
  (cache: PhaseCacheOperations) =>
  (phase: DomainPhase): TE.TaskEither<APIError, void> =>
    pipe(
      cache.cachePhases([{ ...single.fromDomain(phase), createdAt: new Date() }]),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache phase', details: { error } }),
      ),
    );

export const findActivePhase =
  (currentEventId: number) =>
  (phases: readonly DomainPhase[]): DomainPhase | null =>
    phases.find(
      (phase) => phase.startEvent <= currentEventId && phase.stopEvent >= currentEventId,
    ) ?? null;

export const saveBatchPhases = (
  phases: readonly DomainPhase[],
): TE.TaskEither<APIError, readonly DomainPhase[]> =>
  pipe(
    phases,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaPhases) =>
      pipe(phaseRepository.saveBatch(prismaPhases), TE.map(array.toDomain)),
    ),
  );

export const findPhaseById = (id: PhaseId): TE.TaskEither<APIError, DomainPhase | null> =>
  pipe(phaseRepository.findById(id), TE.map(single.toDomain));

export const findAllPhases = (): TE.TaskEither<APIError, readonly DomainPhase[]> =>
  pipe(phaseRepository.findAll(), TE.map(array.toDomain));
