/**
 * Phase Types Module
 *
 * Core type definitions for the Fantasy Premier League phase system.
 * Includes branded types, domain models, and data converters.
 */

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import type { BootstrapApi } from '../domain/bootstrap/types';
import type { PhaseCache } from '../domain/phase/types';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';
import { APIError, DBError } from './error.type';

/**
 * Branded type for Phase ID ensuring type safety
 */
export type PhaseId = Branded<number, 'PhaseId'>;

/**
 * Creates a branded PhaseId with validation
 */
export const createPhaseId = createBrandedType<number, 'PhaseId'>(
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
export interface PhaseRepository extends BaseRepository<PrismaPhase, PrismaPhaseCreate, PhaseId> {
  readonly findByIds: (ids: PhaseId[]) => TE.TaskEither<DBError, PrismaPhase[]>;
  readonly update: (id: PhaseId, phase: PrismaPhaseUpdate) => TE.TaskEither<DBError, PrismaPhase>;
}

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

/**
 * Service interface for Phase operations
 */
export interface PhaseService {
  readonly getPhases: () => TE.TaskEither<APIError, Phases>;
  readonly getPhase: (id: PhaseId) => TE.TaskEither<APIError, Phase | null>;
  readonly savePhases: (phases: Phases) => TE.TaskEither<APIError, Phases>;
  readonly syncPhasesFromApi: () => TE.TaskEither<APIError, Phases>;
}

/**
 * Dependencies required by the PhaseService
 */
export interface PhaseServiceDependencies {
  bootstrapApi: BootstrapApi;
  phaseCache: PhaseCache;
  phaseRepository: PhaseRepository;
}
