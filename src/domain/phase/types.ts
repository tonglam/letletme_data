/**
 * Phase Domain Types Module
 *
 * Core type definitions for the phase domain layer.
 * Includes branded types, domain models, data converters, and domain operations.
 */

import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from '../../types/base.type';
import { CacheError, DomainError } from '../../types/error.type';

/**
 * Branded type for Phase ID ensuring type safety
 */
export type PhaseId = Branded<number, 'PhaseId'>;

/**
 * Creates a branded PhaseId with validation
 */
export const PhaseId = createBrandedType<number, 'PhaseId'>(
  'PhaseId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

/**
 * Validates and converts a value to PhaseId
 */
export const validatePhaseId = (value: unknown): E.Either<string, PhaseId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid phase ID: must be a positive integer',
    ),
    E.map((v) => v as PhaseId),
  );

/**
 * Schema for validating phase response data from the FPL API
 * Only strictly validates fields required by Prisma model
 */
export const PhaseResponseSchema = z
  .object({
    // Required fields (must exist in API response)
    id: z.number(),
    name: z.string(),
    start_event: z.number(),
    stop_event: z.number(),

    // Optional fields (nullable in Prisma)
    highest_score: z.number().nullable(),

    // Other API fields that we don't store
    start_time: z.string().optional(),
    stop_time: z.string().optional(),
  })
  .passthrough();

/**
 * Type for phase response data from the FPL API
 * Inferred from schema to allow additional fields
 */
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;

/**
 * Array of phase responses
 */
export type PhasesResponse = readonly PhaseResponse[];

/**
 * Core phase domain model
 */
export interface Phase {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}

/**
 * Array of phase domain models
 */
export type Phases = readonly Phase[];

/**
 * Phase repository interface
 * Extends base repository with phase-specific operations
 */
export type PhaseRepository = BaseRepository<PrismaPhase, PrismaPhaseCreate, PhaseId>;

/**
 * Prisma database model for Phase
 */
export interface PrismaPhase {
  readonly id: number;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
  readonly createdAt: Date;
}

/**
 * Prisma phase creation type
 */
export type PrismaPhaseCreate = Omit<PrismaPhase, 'createdAt'>;

/**
 * Prisma phase update type
 */
export type PrismaPhaseUpdate = Omit<PrismaPhase, 'createdAt'>;

/**
 * Phase cache interface for domain operations
 */
export interface PhaseCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cachePhase: (phase: Phase) => TE.TaskEither<CacheError, void>;
  readonly cachePhases: (phases: Phases) => TE.TaskEither<CacheError, void>;
  readonly getPhase: (id: string) => TE.TaskEither<CacheError, Phase | null>;
  readonly getAllPhases: () => TE.TaskEither<CacheError, Phases>;
}

/**
 * Phase operations interface for domain logic
 */
export interface PhaseOperations {
  readonly getAllPhases: () => TE.TaskEither<DomainError, Phases>;
  readonly getPhaseById: (id: PhaseId) => TE.TaskEither<DomainError, Phase | null>;
  readonly createPhases: (phases: Phases) => TE.TaskEither<DomainError, Phases>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Converts API response or database model to domain model
 */
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

/**
 * Converts domain model to database model
 */
export const toPrismaPhase = (phase: Phase): PrismaPhaseCreate => ({
  id: Number(phase.id),
  name: phase.name,
  startEvent: phase.startEvent,
  stopEvent: phase.stopEvent,
  highestScore: phase.highestScore,
});
