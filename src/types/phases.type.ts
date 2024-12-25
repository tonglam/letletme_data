import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { APIError } from '../infrastructure/api/common/errors';

// ============ Branded Types ============
declare const PhaseIdBrand: unique symbol;
export type PhaseId = number & { readonly _brand: typeof PhaseIdBrand };

declare const EventIdBrand: unique symbol;
export type EventId = number & { readonly _brand: typeof EventIdBrand };

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
const PhaseResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

export const PhasesResponseSchema = z.array(PhaseResponseSchema);
export const PhasesSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    startEvent: z.number(),
    stopEvent: z.number(),
    highestScore: z.number().nullable(),
  }),
);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
export type PhasesResponse = z.infer<typeof PhasesResponseSchema>;

// ============ Domain Types ============
export interface Phase {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
}

export type Phases = readonly Phase[];

// ============ Type Transformers ============
/**
 * Transform and validate PhaseResponse to Phase
 */
export const toDomainPhase = (raw: PhaseResponse): E.Either<string, Phase> => {
  try {
    if (!isPhaseId(raw.id)) {
      return E.left(`Invalid phase ID: ${raw.id}`);
    }

    const phase: Phase = {
      id: raw.id as PhaseId,
      name: raw.name,
      startEvent: raw.start_event,
      stopEvent: raw.stop_event,
      highestScore: raw.highest_score,
    };

    if (!isValidPhase(phase)) {
      return E.left('Invalid phase data');
    }

    return E.right(phase);
  } catch (error) {
    return E.left(
      `Failed to transform phase data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// ============ Persistence Types ============
export interface PrismaPhase {
  readonly id: number;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
  readonly createdAt: Date;
}

export interface PrismaPhaseCreate extends Omit<PrismaPhase, 'id'> {
  readonly id?: number;
}

// ============ Type Guards & Validation ============
export const isPhaseId = (id: unknown): id is PhaseId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validatePhaseId = (id: number): E.Either<string, PhaseId> =>
  isPhaseId(id) ? E.right(id as PhaseId) : E.left(`Invalid phase ID: ${id}`);

export const isEventId = (id: unknown): id is EventId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validateEventId = (id: number): E.Either<string, EventId> =>
  isEventId(id) ? E.right(id as EventId) : E.left(`Invalid event ID: ${id}`);

export const isValidPhase = (phase: Phase): boolean =>
  isPhaseId(phase.id) &&
  typeof phase.name === 'string' &&
  phase.name.length > 0 &&
  Number.isInteger(phase.startEvent) &&
  phase.startEvent > 0 &&
  Number.isInteger(phase.stopEvent) &&
  phase.stopEvent >= phase.startEvent &&
  (phase.highestScore === null ||
    (typeof phase.highestScore === 'number' && phase.highestScore >= 0));

export interface PhaseRepository {
  prisma: PrismaClient;
  findById(id: PhaseId): TE.TaskEither<APIError, PrismaPhase | null>;
  findAll(): TE.TaskEither<APIError, PrismaPhase[]>;
  save(data: PrismaPhaseCreate): TE.TaskEither<APIError, PrismaPhase>;
  saveBatch(data: PrismaPhaseCreate[]): TE.TaskEither<APIError, PrismaPhase[]>;
  update(id: PhaseId, data: Partial<PrismaPhaseCreate>): TE.TaskEither<APIError, PrismaPhase>;
  deleteAll(): TE.TaskEither<APIError, void>;
  findByIds(ids: PhaseId[]): TE.TaskEither<APIError, PrismaPhase[]>;
  deleteByIds(ids: PhaseId[]): TE.TaskEither<APIError, void>;
}
