import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type PhaseId = Branded<number, 'PhaseId'>;

export const PhaseId = createBrandedType<number, 'PhaseId'>(
  'PhaseId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export interface PhaseResponse {
  readonly id: number;
  readonly name: string;
  readonly start_event: number;
  readonly stop_event: number;
  readonly highest_score: number | null;
}

export type PhasesResponse = readonly PhaseResponse[];

/**
 * Domain types (camelCase)
 */
export interface Phase {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}

export type Phases = readonly Phase[];

// ============ Repository Interface ============
export type PhaseRepository = BaseRepository<PrismaPhase, PrismaPhaseCreate, PhaseId>;

// ============ Persistence Types ============
export interface PrismaPhase {
  readonly id: number;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
  readonly createdAt: Date;
}

export type PrismaPhaseCreate = Omit<PrismaPhase, 'createdAt'>;

// ============ Converters ============
export const toDomainPhase = (data: PhaseResponse | PrismaPhase): Phase => {
  const isPhaseApiResponse = (d: PhaseResponse | PrismaPhase): d is PhaseResponse =>
    isApiResponse(d, 'start_event');

  return {
    id: data.id as PhaseId,
    name: data.name,
    startEvent: isPhaseApiResponse(data) ? data.start_event : data.startEvent,
    stopEvent: isPhaseApiResponse(data) ? data.stop_event : data.stopEvent,
    highestScore: isPhaseApiResponse(data) ? data.highest_score : data.highestScore,
  };
};

export const convertPrismaPhases = (
  phases: readonly PrismaPhase[],
): TE.TaskEither<string, Phases> =>
  pipe(
    phases,
    TE.right,
    TE.map((values) => values.map(toDomainPhase)),
  );

export const convertPrismaPhase = (
  phase: PrismaPhase | null,
): TE.TaskEither<string, Phase | null> => TE.right(phase ? toDomainPhase(phase) : null);
