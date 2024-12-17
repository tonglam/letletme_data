import { Either, left, right } from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { APIError } from '../infrastructure/api/common/errors';

// ============ Branded Types ============
/**
 * Branded types for type-safe IDs
 */
export type PhaseId = number & { readonly _brand: unique symbol };
export type EventId = number & { readonly _brand: unique symbol };

// ============ Validation Functions ============
/**
 * Validates a phase ID
 */
export const validatePhaseId = (id: number): Either<string, PhaseId> =>
  id > 0 ? right(id as PhaseId) : left(`Invalid phase ID: ${id}. Must be a positive number`);

/**
 * Validates an event ID
 */
export const validateEventId = (id: number): Either<string, EventId> =>
  id > 0 ? right(id as EventId) : left(`Invalid event ID: ${id}. Must be a positive number`);

// ============ Error Types ============
/**
 * Phase-specific error types
 */
export type PhaseError =
  | { type: 'INVALID_PHASE_ID'; message: string }
  | { type: 'INVALID_EVENT_ID'; message: string }
  | { type: 'INVALID_PHASE_RANGE'; message: string }
  | { type: 'PHASE_NOT_FOUND'; message: string };

// ============ API Types ============
/**
 * API Response Schema (snake_case)
 */
export const PhaseResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

export const PhasesResponseSchema = z.array(PhaseResponseSchema);
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
export type PhasesResponse = z.infer<typeof PhasesResponseSchema>;

// ============ Domain Types ============
/**
 * Domain Schema (camelCase)
 */
export const PhaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  startEvent: z.number(),
  stopEvent: z.number(),
  highestScore: z.number().nullable(),
});

export const PhasesSchema = z.array(PhaseSchema);
export type Phase = z.infer<typeof PhaseSchema>;
export type Phases = z.infer<typeof PhasesSchema>;

// ============ Database Types ============
/**
 * Prisma Model (database schema)
 */
export type PrismaPhase = {
  readonly id: number;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
  readonly createdAt: Date;
};

/**
 * Type for creating new phase (without auto-generated fields)
 * Note: ID is handled internally by the repository
 */
export type PrismaPhaseCreate = {
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore?: number | null;
};

// ============ Repository Types ============
/**
 * Repository operations
 */
export interface PhaseRepository {
  save(phase: PrismaPhaseCreate): TE.TaskEither<APIError, PrismaPhase>;
  findById(id: PhaseId): TE.TaskEither<APIError, PrismaPhase | null>;
  findAll(): TE.TaskEither<APIError, PrismaPhase[]>;
  update(id: PhaseId, phase: Partial<PrismaPhaseCreate>): TE.TaskEither<APIError, PrismaPhase>;
}

// ============ Type Transformers ============
/**
 * Transform API response to domain model
 */
export const toDomainPhase = (raw: PhaseResponse): Either<string, Phase> => {
  const result = PhaseSchema.safeParse({
    id: raw.id,
    name: raw.name,
    startEvent: raw.start_event,
    stopEvent: raw.stop_event,
    highestScore: raw.highest_score,
  });

  return result.success
    ? right(result.data)
    : left(`Invalid domain model: ${result.error.message}`);
};
