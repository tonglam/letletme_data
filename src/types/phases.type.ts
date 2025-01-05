import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type PhaseId = Branded<number, 'PhaseId'>;

export const PhaseId = createBrandedType<number, 'PhaseId'>(
  'PhaseId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validatePhaseId = (value: unknown): E.Either<string, PhaseId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid phase ID: must be a positive integer',
    ),
    E.map((v) => v as PhaseId),
  );

// ============ Types ============
// API response types representing raw data from external API
export const PhaseResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

export interface PhaseResponse {
  readonly id: number;
  readonly name: string;
  readonly start_event: number;
  readonly stop_event: number;
  readonly highest_score: number | null;
}

export type PhasesResponse = readonly PhaseResponse[];

// Domain types representing phase data in our system
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
export type PrismaPhaseUpdate = Omit<PrismaPhase, 'createdAt'>;

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

export const toPrismaPhase = (phase: Phase): PrismaPhaseCreate => ({
  id: Number(phase.id),
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: phase.highestScore,
});
