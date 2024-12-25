import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/api/common/errors';
import { createValidationError } from '../../infrastructure/api/common/errors';
import type {
  Phase as DomainPhase,
  PhaseId,
  PrismaPhase,
  PrismaPhaseCreate,
} from '../../types/phase.type';
import type { PhaseCacheOperations } from './cache/cache';
import { phaseRepository } from './repository';

export const createError = (message: string, cause?: unknown): APIError =>
  createValidationError({ message, details: { cause } });

// Domain transformations
export const toDomainPhase = (prismaPhase: PrismaPhase): DomainPhase => ({
  id: prismaPhase.id as PhaseId,
  name: prismaPhase.name,
  startEvent: prismaPhase.startEvent,
  stopEvent: prismaPhase.stopEvent,
  highestScore: prismaPhase.highestScore,
});

// Base transformation without id
const toBasePrismaPhase = (phase: DomainPhase) => ({
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: phase.highestScore,
  createdAt: new Date(),
});

export const toPrismaPhase = (phase: DomainPhase): PrismaPhase => ({
  id: Number(phase.id),
  ...toBasePrismaPhase(phase),
});

export const toPrismaPhaseCreate = (phase: DomainPhase): PrismaPhaseCreate =>
  toBasePrismaPhase(phase);

const toPrismaPhaseWithError = (phase: DomainPhase): E.Either<APIError, PrismaPhaseCreate> =>
  E.tryCatch(
    () => toPrismaPhaseCreate(phase),
    (error) => createError('Invalid phase data', error),
  );

const toDomainPhaseWithError = (phase: PrismaPhase): E.Either<APIError, DomainPhase> =>
  E.tryCatch(
    () => toDomainPhase(phase),
    (error) => createError('Failed to convert phase', error),
  );

const ensurePrismaPhase = (phase: unknown): E.Either<APIError, PrismaPhase> => {
  if (
    typeof phase === 'object' &&
    phase !== null &&
    'id' in phase &&
    'name' in phase &&
    'startEvent' in phase &&
    'stopEvent' in phase &&
    'highestScore' in phase &&
    'createdAt' in phase
  ) {
    return E.right(phase as PrismaPhase);
  }
  return E.left(createError('Invalid PrismaPhase object'));
};

const ensurePrismaPhaseArray = (phases: unknown): E.Either<APIError, PrismaPhase[]> => {
  if (Array.isArray(phases)) {
    const validatedPhases = phases.map((phase) => ensurePrismaPhase(phase));
    const errors = validatedPhases.filter(E.isLeft).map((e) => e.left);
    if (errors.length > 0) {
      return E.left(createError('Invalid PrismaPhase array', errors));
    }
    return E.right(validatedPhases.filter(E.isRight).map((p) => p.right));
  }
  return E.left(createError('Expected array of PrismaPhase objects'));
};

export const savePhase = (phase: DomainPhase): TE.TaskEither<APIError, DomainPhase> =>
  pipe(
    toPrismaPhaseWithError(phase),
    TE.fromEither,
    TE.chain((prismaPhase) =>
      pipe(
        phaseRepository.save({ ...prismaPhase, id: Number(phase.id) }),
        TE.chain((saved) =>
          pipe(
            ensurePrismaPhase(saved),
            TE.fromEither,
            TE.chain((validPhase) => pipe(toDomainPhaseWithError(validPhase), TE.fromEither)),
          ),
        ),
      ),
    ),
  );

export const cachePhase =
  (cache: PhaseCacheOperations) =>
  (phase: DomainPhase): TE.TaskEither<APIError, void> =>
    pipe(
      toPrismaPhaseWithError(phase),
      TE.fromEither,
      TE.chain((prismaPhase) =>
        pipe(
          cache.cachePhases([{ ...prismaPhase, id: Number(phase.id) }]),
          TE.mapLeft((error) => createError('Failed to cache phase', error)),
        ),
      ),
    );

export const findActivePhase =
  (currentEventId: number) =>
  (phases: readonly DomainPhase[]): DomainPhase | null =>
    phases.find(
      (phase) => phase.startEvent <= currentEventId && phase.stopEvent >= currentEventId,
    ) ?? null;

export const validatePhaseSequence = (
  phases: readonly DomainPhase[],
): TE.TaskEither<APIError, readonly DomainPhase[]> => {
  // Skip the "Overall" phase when checking for overlaps
  const monthlyPhases = phases.filter((phase) => phase.name !== 'Overall');

  for (let i = 1; i < monthlyPhases.length; i++) {
    if (monthlyPhases[i].startEvent <= monthlyPhases[i - 1].stopEvent) {
      return TE.left(createError('Phase sequence invalid: overlapping phases detected'));
    }
  }
  return TE.right(phases);
};

export const saveBatchPhases = (
  phases: readonly DomainPhase[],
): TE.TaskEither<APIError, readonly DomainPhase[]> =>
  pipe(
    phases,
    TE.traverseArray((phase) => pipe(toPrismaPhaseWithError(phase), TE.fromEither)),
    TE.chain((prismaPhases) =>
      pipe(
        phaseRepository.saveBatch(prismaPhases.map((p, i) => ({ ...p, id: Number(phases[i].id) }))),
        TE.chain((savedPhases) =>
          pipe(
            ensurePrismaPhaseArray(savedPhases),
            TE.fromEither,
            TE.chain((validPhases) =>
              pipe(
                validPhases,
                TE.traverseArray((phase) => pipe(toDomainPhaseWithError(phase), TE.fromEither)),
              ),
            ),
          ),
        ),
      ),
    ),
  );

export const findPhaseById = (id: PhaseId): TE.TaskEither<APIError, DomainPhase | null> =>
  pipe(
    phaseRepository.findById(id),
    TE.chain((phase) =>
      phase
        ? pipe(
            ensurePrismaPhase(phase),
            TE.fromEither,
            TE.chain((validPhase) => pipe(toDomainPhaseWithError(validPhase), TE.fromEither)),
          )
        : TE.right(null),
    ),
  );

export const findAllPhases = (): TE.TaskEither<APIError, readonly DomainPhase[]> =>
  pipe(
    phaseRepository.findAll(),
    TE.chain((phases) =>
      pipe(
        ensurePrismaPhaseArray(phases),
        TE.fromEither,
        TE.chain((validPhases) =>
          pipe(
            validPhases,
            TE.traverseArray((phase) => pipe(toDomainPhaseWithError(phase), TE.fromEither)),
          ),
        ),
      ),
    ),
  );
